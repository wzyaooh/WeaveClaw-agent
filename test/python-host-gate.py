import asyncio
import json
import os
import socket
import shutil
import sqlite3
import tempfile
from pathlib import Path
from contextlib import closing
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import uvicorn
from fastapi import FastAPI
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart

from novelvideo.api.routes.desktop_orchestrator import router
from novelvideo.chat.orchestrator_link import OrchestratorLink
from novelvideo.chat.orchestrator_runtime import OrchestratorRuntime
from novelvideo.chat.business_tools import TOOL_SPECS
from novelvideo.models import NO_CHARACTER_MARKER
from novelvideo.services.creation_progress import creation_progress
from novelvideo.utils.path_resolver import PathResolver

ELECTRON = os.environ.get('WEAVECLAW_TEST_ELECTRON')
NODE = ELECTRON or os.environ.get('WEAVECLAW_TEST_NODE') or shutil.which('node')
CLIENT = str(Path(__file__).with_name('electron-python-host.cjs' if ELECTRON else 'python-host-client.mjs'))
if not NODE:
    raise RuntimeError('Node.js or Electron is required for this development test')

class Model:
    profile = SimpleNamespace(supports_tools=True)
    def __init__(self, expected_reason, resumed=False, write_tool=None):
        self.calls = 0
        self.expected_reason = expected_reason
        self.resumed = resumed
        self.write_tool = write_tool
    async def request(self, messages, settings, parameters):
        self.calls += 1
        assert '管线顺序：' in messages[0].parts[0].content
        assert 'host controls identity' in messages[0].parts[0].content
        assert messages[1].parts[0].content == 'previous user message'
        if self.calls == 1:
            assert 'weaveclaw_generate_script' not in {item.name for item in parameters.function_tools}
            assert not {'weaveclaw_plan_scenes', 'weaveclaw_plan_props'} & {item.name for item in parameters.function_tools}
            if self.resumed:
                assert 'reason=progress_required' in messages[0].parts[0].content
            return ModelResponse(parts=[TextPart('先读取素材'), ToolCallPart('weaveclaw_get_creation_progress', {'episode': 2}, 'read-1')],
                                 finish_reason='tool_call', model_name='mock')
        assert ('weaveclaw_generate_script' in {item.name for item in parameters.function_tools}) == (self.expected_reason != 'episode_missing')
        assert f'reason={self.expected_reason}' in messages[0].parts[0].content
        if self.expected_reason == 'await_task':
            assert 'weaveclaw_generate_audio' not in {item.name for item in parameters.function_tools}
        if self.expected_reason in ('audio_stale', 'audio_unknown'):
            assert not {'weaveclaw_start_single_video', 'weaveclaw_compose_episode', 'weaveclaw_get_final_video'} & {item.name for item in parameters.function_tools}
        assert any(isinstance(part, ToolReturnPart) and part.content['data']['episode']['number'] == 2
                   for message in messages for part in message.parts)
        actual = next(part.content['data'] for message in messages for part in message.parts
                      if isinstance(part, ToolReturnPart) and 'episode' in part.content.get('data', {}))
        episode = actual['episode']
        ready = episode['exists'] and episode['beats'] > 0 and episode['all_beats_have_content'] and 'script' not in actual['active_steps']
        assert ({'weaveclaw_plan_scenes', 'weaveclaw_plan_props'} <= {item.name for item in parameters.function_tools}) == ready
        if self.write_tool:
            return ModelResponse(parts=[ToolCallPart(self.write_tool, {'episode': 2}, 'plan-1')],
                                 finish_reason='tool_call', model_name='mock')
        if self.expected_reason != 'script_required':
            return ModelResponse(parts=[TextPart('已收到进度建议')], finish_reason='stop', model_name='mock')
        return ModelResponse(parts=[ToolCallPart('weaveclaw_generate_script', {'episode': 2}, 'call-1')],
                             finish_reason='tool_call', model_name='mock')

class Dispatcher:
    def __init__(self, scenario, root): self.write_attempted = False; self.calls = []; self.scenario = scenario; self.root = root
    def definitions(self):
        real_tools = [SimpleNamespace(name=spec.name, description=spec.description, parameters_json_schema=spec.schema)
                      for spec in TOOL_SPECS.values()]
        return real_tools
    def validate(self, name, args):
        assert name in ('weaveclaw_get_creation_progress', 'weaveclaw_generate_script', 'weaveclaw_plan_scenes', 'weaveclaw_plan_props') and args == {'episode': 2}
        return SimpleNamespace(writes=name != 'weaveclaw_get_creation_progress')
    async def dispatch(self, name, args):
        self.calls.append((name, args))
        if name == 'weaveclaw_get_creation_progress':
            if self.scenario.startswith('real_'):
                return {'ok': True, 'data': await self.real_progress()}
            data = {'version': 1, 'source': {'uploads': 1, 'imported': True},
                'project': {'characters': 1, 'episodes': 1},
                'episode': {'number': 2, 'exists': True, 'identity_planned': True, 'beats': 0,
                    'all_beats_have_content': False, 'sketches_missing': 0, 'sketches_stale': 0,
                    'identity_detected': 0, 'first_frames_present': 0}, 'active_steps': []}
            if self.scenario == 'config_recommendation':
                data['project']['configured'] = False
            elif self.scenario == 'sketches_stale':
                data['episode'].update(beats=1, all_beats_have_content=True, sketches_stale=1)
            elif self.scenario == 'quality_retry':
                data['episode'].update(beats=1, all_beats_have_content=True, identity_detected=1,
                                       video_prompt_present=1, first_frames_present=1,
                                       first_frames_quality=False, retry_count=0)
            return {'ok': True, 'data': data}
        self.write_attempted = True
        return {'ok': True, 'result': 'verified'}

    async def real_progress(self):
        if hasattr(self, 'resume_context'):
            from novelvideo import creation_repository
            ctx, store = self.resume_context
            creation_repository.register(ctx.output_dir, ctx.state_dir / 'data.db')
            try:
                return await creation_progress(ctx, store, 2)
            finally:
                creation_repository._databases.pop(str(ctx.output_dir.resolve()), None)
        output = self.root / self.scenario / 'output'
        state = self.root / self.scenario / 'state'
        output.mkdir(parents=True, exist_ok=True); state.mkdir(parents=True, exist_ok=True)
        (output / 'novel.txt').write_text('fixture', encoding='utf-8')
        stage = 'audio_accepted' if self.scenario == 'real_resume' else self.scenario.removeprefix('real_')
        beats = [{'beat_number': n, 'narration_segment': 'fixture', 'detected_identities': [NO_CHARACTER_MARKER],
                  'audio_type': 'silence' if n == 2 else 'narration',
                  'video_mode': 'i2v' if stage != 'global_optimize_required' else '',
                  'video_prompt': 'fixture' if stage != 'global_optimize_required' else ''} for n in (1, 2)]
        paths = PathResolver(str(output), 2)
        files = [paths.sketch(n) for n in (1, 2)]
        if stage not in ('global_optimize_required', 'first_frames_required'):
            files += [paths.frame(n) for n in (1, 2)]
        if stage in ('audio_unknown', 'audio_accepted', 'audio_rejected', 'audio_changed'):
            files.append(paths.audio(1))
        for path in files:
            path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b'fixture')
        if stage == 'await_task':
            with closing(sqlite3.connect(state / 'data.db')) as db:
                db.execute('CREATE TABLE task_states(project_id TEXT, task_type TEXT, episode INTEGER, status TEXT, expires_at TEXT, updated_at TEXT)')
                db.execute('INSERT INTO task_states VALUES(?,?,?,?,?,?)', ('fixture-project', 'audio_generation_indextts2', 2, 'running', None, '2026-11-11'))
                db.commit()
        if stage == 'audio_stale':
            from novelvideo import creation_repository
            from novelvideo.services import generated_audio as audio
            from novelvideo.sqlite_store import SQLiteStore
            store = SQLiteStore('fixture', output_dir=str(output), state_dir=str(state))
            store._ensure_project_schema_sync()
            database = state / 'data.db'
            creation_repository.register(output, database)
            voice = output / 'assets/voice.wav'; voice.parent.mkdir(parents=True); voice.write_bytes(b'voice')
            ctx = SimpleNamespace(project_id='fixture-project', output_dir=output, state_dir=state)
            stat = database.stat(); identity = [stat.st_dev, stat.st_ino]
            with closing(sqlite3.connect(database)) as db:
                db.row_factory = sqlite3.Row
                db.execute("INSERT INTO episodes(number) VALUES(2)")
                db.execute("INSERT INTO beats(episode_number,beat_number,narration,audio_type) VALUES(2,1,'old','narration')")
                db.commit()
                old = audio._snapshot(ctx, db, identity, 2, 1)
                candidate = {'id': 'audio-fixture', 'path': 'assets/generated-audio/fixture/current.mp3', 'sha256': audio._hash(b'audio')}
                source = {'voice_source': 'assets/voice.wav', 'voice_sha256': audio._hash(b'voice')}
                target = output / candidate['path']; target.parent.mkdir(parents=True); target.write_bytes(b'audio')
                db.execute('INSERT INTO generated_audio_items(id,operation_id,beat_num,snapshot_json,input_json,status,candidate_json) VALUES(?,?,?,?,?,?,?)',
                           ('audio-fixture', 'batch', 1, json.dumps(old), json.dumps(source), 'adopted', json.dumps(candidate)))
                audio._head(db, old, candidate, source, 'generated')
                db.commit()
                db.execute("UPDATE beats SET narration='new dialogue' WHERE episode_number=2 AND beat_number=1")
                db.commit()
        if stage in ('audio_accepted', 'audio_rejected', 'audio_changed'):
            from novelvideo import creation_repository
            from novelvideo.services.creation_media_review import decide, inspect
            from novelvideo.sqlite_store import SQLiteStore
            store = SQLiteStore('fixture', output_dir=str(output), state_dir=str(state))
            store._ensure_project_schema_sync()
            database = state / 'data.db'
            creation_repository.register(output, database)
            with closing(sqlite3.connect(database)) as db:
                db.execute("INSERT INTO episodes(number) VALUES(2)")
                db.execute("INSERT INTO beats(episode_number,beat_number,narration,audio_type) VALUES(2,1,'dialogue','narration')")
                db.execute("INSERT INTO beats(episode_number,beat_number,narration,audio_type) VALUES(2,2,'','silence')")
                db.commit()
            ctx = SimpleNamespace(project_id='fixture-project', output_dir=output, state_dir=state)
            [target] = inspect(ctx, 2, beats)
            decide(ctx, 2, beats, 'audio', 1, target['version'], 'reject' if stage == 'audio_rejected' else 'accept', 'test-user')
            if stage == 'audio_changed':
                paths.audio(1).write_bytes(b'replaced')
        episode = SimpleNamespace(identity_ids=['fixture'])
        fixture = self
        class Store:
            def get_all_characters(self): return [object()]
            def get_all_episodes(self): return [episode] if self.get_episode(2) else []
            def get_episode(self, number):
                if number != 2: return None
                if fixture.scenario == 'real_resume':
                    with closing(sqlite3.connect(state / 'data.db')) as db:
                        return episode if db.execute('SELECT 1 FROM episodes WHERE number=?', (number,)).fetchone() else None
                return episode
            async def get_beats_as_dicts(self, number): return beats
        ctx = SimpleNamespace(project_id='fixture-project', output_dir=output, state_dir=state)
        store = Store()
        result = await creation_progress(ctx, store, 2)
        if self.scenario == 'real_resume':
            self.resume_context = (ctx, store)
            self.resume_beats = beats
        if stage in ('audio_stale', 'audio_accepted', 'audio_rejected', 'audio_changed'):
            creation_repository._databases.pop(str(output.resolve()), None)
        if stage == 'audio_stale':
            assert result['episode']['audio_stale'] == 1
        if stage == 'audio_accepted':
            assert result['episode']['audio_unknown'] == 1 and result['episode']['audio_confirmed'] == 1
        if stage in ('audio_rejected', 'audio_changed'):
            assert result['episode']['audio_unknown'] == 1 and result['episode']['audio_confirmed'] == 0
        return result

async def main():
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); sock.listen(100); sock.setblocking(False)
    port = sock.getsockname()[1]
    token = 'orchestrator-test-token-' * 3
    os.environ['WEAVECLAW_API_PORT'] = str(port)
    os.environ['WEAVECLAW_DESKTOP_TOKEN'] = 'desktop-proof-' * 4
    app = FastAPI(); app.state.desktop_mode = True; app.state.orchestrator_link = OrchestratorLink()
    app.state.orchestrator_token = token
    app.include_router(router, prefix='/api/v1')
    server = uvicorn.Server(uvicorn.Config(app, log_level='error', lifespan='off'))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    async with asyncio.timeout(10):
        while not server.started:
            if task.done():
                raise RuntimeError("Python test server failed to start")
            await asyncio.sleep(0.01)
    child_env = {key: value for key, value in os.environ.items() if not key.upper().startswith("WEAVECLAW_")}
    if ELECTRON:
        child_env["PI_TEST_CONFIG"] = json.dumps({"url": f"ws://127.0.0.1:{port}/api/v1/desktop/orchestrator/ws", "token": token})
    child = await asyncio.create_subprocess_exec(NODE, CLIENT, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=child_env)
    try:
        if not ELECTRON:
            child.stdin.write((json.dumps({'url': f'ws://127.0.0.1:{port}/api/v1/desktop/orchestrator/ws', 'token': token}) + '\n').encode())
            await child.stdin.drain()
        async with asyncio.timeout(10):
            while True:
                line = await child.stdout.readline()
                if line.strip() == b'READY':
                    break
                if not line:
                    raise RuntimeError('test process failed to start')
        temp = tempfile.TemporaryDirectory()
        for scenario in ('script_required', 'config_recommendation', 'sketches_stale', 'quality_retry',
                         'real_global_optimize_required', 'real_first_frames_required', 'real_audio_required',
                         'real_audio_unknown', 'real_audio_stale', 'real_audio_accepted', 'real_audio_rejected',
                         'real_audio_changed', 'real_await_task'):
            expected = {'real_audio_accepted': 'video_required', 'real_audio_rejected': 'audio_unknown',
                        'real_audio_changed': 'audio_unknown'}.get(scenario, scenario.removeprefix('real_'))
            dispatcher, model = Dispatcher(scenario, Path(temp.name)), Model(expected)
            bindings = []
            async def bind_strategy(digest):
                bindings.append(digest)
            result = await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=model,
                dispatcher=dispatcher, stream=False).run('private prompt', scope='project', bind_strategy=bind_strategy,
                    history=[{'role': 'user', 'content': 'previous user message'}]), 10)
            expected_calls = [('weaveclaw_get_creation_progress', {'episode': 2})]
            if scenario == 'script_required':
                expected_calls.append(('weaveclaw_generate_script', {'episode': 2}))
            assert len(bindings) == 1 and len(bindings[0]) == 64
            assert result.write_attempted == (scenario == 'script_required')
            assert model.calls == 2 and dispatcher.calls == expected_calls
        for tool in ('weaveclaw_plan_scenes', 'weaveclaw_plan_props'):
            dispatcher = Dispatcher('real_global_optimize_required', Path(temp.name) / tool)
            model = Model('global_optimize_required', write_tool=tool)
            result = await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=model,
                dispatcher=dispatcher, stream=False).run('plan episode assets', scope='project', bind_strategy=bind_strategy,
                    history=[{'role': 'user', 'content': 'previous user message'}]), 10)
            assert result.write_attempted and model.calls == 2
            assert dispatcher.calls == [('weaveclaw_get_creation_progress', {'episode': 2}), (tool, {'episode': 2})]
        from novelvideo.chat.business_tools import BusinessToolDispatcher, BusinessToolError
        for tool in ('weaveclaw_plan_scenes', 'weaveclaw_plan_props'):
            for changed in (False, True):
                fixture = Dispatcher('real_resume', Path(temp.name) / f'{tool}-{changed}')
                requests, claim = [], AsyncMock(return_value=True)
                async def request(method, path, *, query=None, body=None):
                    requests.append((method, path))
                    if method == 'GET':
                        if changed and len(requests) == 2:
                            fixture.resume_beats.clear()
                        return {'ok': True, 'data': await fixture.real_progress()}
                    return {'ok': True, 'task_id': 'fixture-task'}
                dispatcher = BusinessToolDispatcher(project_id='fixture-project', request=request,
                    authorize=AsyncMock(), claim_write=claim)
                model = Model('video_required', write_tool=tool)
                with patch('novelvideo.chat.business_tools._plan_allows_tool', return_value=True), \
                        patch('novelvideo.chat.business_tools.preflight_tool_dependencies'):
                    runtime = OrchestratorRuntime(link=app.state.orchestrator_link, model=model,
                        dispatcher=dispatcher, stream=False)
                    try:
                        result = await asyncio.wait_for(runtime.run('plan episode assets', scope='project',
                            bind_strategy=bind_strategy, history=[{'role': 'user', 'content': 'previous user message'}]), 10)
                    except BusinessToolError as exc:
                        assert changed and str(exc) == 'existing_beats_required'
                        claim.assert_not_awaited()
                        assert [method for method, _ in requests] == ['GET', 'GET']
                    else:
                        assert not changed and result.write_attempted
                        claim.assert_awaited_once()
                        assert [method for method, _ in requests] == ['GET', 'GET', 'POST']
        from novelvideo.chat.store import ChatScope, ChatStore
        class ProjectChat(ChatStore):
            def db_for(self, username, scope):
                return Path(temp.name) / 'resume-chat.db'
        messages, scope = ProjectChat(), ChatScope('project', 'fixture-project')
        dispatcher = Dispatcher('real_resume', Path(temp.name))
        from novelvideo.chat.business_session import remember_creation_progress
        async def remember(name, args, value):
            await remember_creation_progress(messages, 'user', scope, 'principal', name, args, value)
        for index, expected in enumerate(('video_required', 'audio_unknown', 'episode_missing')):
            if index == 1:
                PathResolver(str(dispatcher.resume_context[0].output_dir), 2).audio(1).write_bytes(b'replaced after interruption')
            if index == 2:
                with closing(sqlite3.connect(dispatcher.resume_context[0].state_dir / 'data.db')) as db:
                    db.execute('DELETE FROM episodes WHERE number=2')
                    db.commit()
            last_episode = messages.last_creation_episode('user', scope, 'principal')
            model = Model(expected, resumed=index > 0)
            result = await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=model,
                dispatcher=dispatcher, stream=False, on_fresh_read=remember).run('private prompt', scope='project',
                    bind_strategy=bind_strategy, last_episode=last_episode,
                    history=[{'role': 'user', 'content': 'previous user message'}]), 10)
            assert not result.write_attempted and model.calls == 2
            assert messages.last_creation_episode('user', scope, 'principal') == (2 if index < 2 else None)
        temp.cleanup()
        print('Python–Pi local WebSocket: verified asset planner gates, host recheck, resume and media changes')
    finally:
        if ELECTRON:
            server.should_exit = True
            await task
        if child.returncode is None:
            try:
                if ELECTRON:
                    await asyncio.wait_for(child.wait(), 5)
                else:
                    child.terminate()
            except asyncio.TimeoutError:
                child.terminate()
            except ProcessLookupError:
                pass
        await child.wait()
        server.should_exit = True
        await task


asyncio.run(main())

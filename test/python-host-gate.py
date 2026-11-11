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
        if self.expected_reason in ('quality_retry', 'quality_failed'):
            assert not {'weaveclaw_generate_audio', 'weaveclaw_start_single_video', 'weaveclaw_compose_episode'} & {item.name for item in parameters.function_tools}
        assert any(isinstance(part, ToolReturnPart) and part.content['data']['episode']['number'] == 2
                   for message in messages for part in message.parts)
        actual = next(part.content['data'] for message in messages for part in message.parts
                      if isinstance(part, ToolReturnPart) and 'episode' in part.content.get('data', {}))
        episode = actual['episode']
        ready = episode['exists'] and episode['beats'] > 0 and episode['all_beats_have_content'] and 'script' not in actual['active_steps']
        assert ({'weaveclaw_plan_scenes', 'weaveclaw_plan_props'} <= {item.name for item in parameters.function_tools}) == ready
        if self.write_tool:
            args = {'episode': 2, **({'beat': 1} if self.write_tool == 'weaveclaw_start_single_video' else {})}
            return ModelResponse(parts=[ToolCallPart(self.write_tool, args, 'plan-1')],
                                 finish_reason='tool_call', model_name='mock')
        if self.expected_reason != 'script_required':
            return ModelResponse(parts=[TextPart('已收到进度建议')], finish_reason='stop', model_name='mock')
        return ModelResponse(parts=[ToolCallPart('weaveclaw_generate_script', {'episode': 2}, 'call-1')],
                             finish_reason='tool_call', model_name='mock')

class Dispatcher:
    def __init__(self, scenario, root): self.write_attempted = False; self.calls = []; self.scenario = scenario; self.root = root; self.project_id = 'fixture-project'
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
                data['source']['ingest'] = 'completed'
            elif self.scenario == 'sketches_stale':
                data['episode'].update(beats=1, all_beats_have_content=True, sketches_stale=1)
            elif self.scenario in ('quality_retry', 'quality_failed'):
                data['episode'].update(beats=1, all_beats_have_content=True, identity_detected=1,
                                       video_prompt_present=1, first_frames_present=1,
                                       first_frames_quality=False, retry_count=0 if self.scenario == 'quality_retry' else 1)
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
        if stage != 'config_recommendation':
            (state / 'project_config.json').write_text(json.dumps({'visual_style': 'anime', 'narration_style': 'third_person',
                'ethnicity': 'Chinese', 'rhythm': 'medium'}), encoding='utf-8')
        else:
            with closing(sqlite3.connect(state / 'data.db')) as db:
                db.execute('CREATE TABLE IF NOT EXISTS task_states(project_id TEXT, task_type TEXT, episode INTEGER, status TEXT, expires_at TEXT, updated_at TEXT)')
                if not db.execute('SELECT 1 FROM task_states').fetchone():
                    db.execute('INSERT INTO task_states VALUES(?,?,?,?,?,?)', ('fixture-project', 'ingest_fast', 0, 'completed', None, '2026-11-12'))
                db.commit()
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
        if stage == 'quality_failed':
            from novelvideo.verification.workbench import ReviewRequest, new_run, run_dir, update_report
            report = new_run(output, 2, beats, {}, ReviewRequest(operation='frame'))
            update_report(run_dir(output, 2, report['run_id']), status='completed', results=[
                {'beat_number': 1, 'status': 'failed', 'data': {'passed': False}},
                {'beat_number': 2, 'status': 'passed', 'data': {'passed': True}}])
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
            def get_sketch_colors(self, number): return {}
            def get_all_episodes(self): return [episode] if self.get_episode(2) else []
            def get_episode(self, number):
                if number != 2: return None
                if fixture.scenario == 'real_resume':
                    with closing(sqlite3.connect(state / 'data.db')) as db:
                        return episode if db.execute('SELECT 1 FROM episodes WHERE number=?', (number,)).fetchone() else None
                return episode
            async def get_beats_as_dicts(self, number): return beats
        ctx = SimpleNamespace(project_id='fixture-project', output_dir=output, state_dir=state,
                              owner_username='fixture', project_name='fixture')
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
        for scenario in ('script_required', 'config_recommendation', 'sketches_stale', 'quality_retry', 'quality_failed',
                         'real_global_optimize_required', 'real_first_frames_required', 'real_audio_required',
                         'real_audio_unknown', 'real_audio_stale', 'real_audio_accepted', 'real_audio_rejected',
                         'real_audio_changed', 'real_await_task', 'real_quality_failed'):
            expected = {'real_audio_accepted': 'video_required', 'real_audio_rejected': 'audio_unknown',
                        'real_audio_changed': 'audio_unknown'}.get(scenario, scenario.removeprefix('real_'))
            dispatcher, model = Dispatcher(scenario, Path(temp.name)), Model(expected)
            bindings, events = [], []
            async def bind_strategy(digest):
                bindings.append(digest)
            async def on_event(event):
                events.append(event)
            result = await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=model,
                dispatcher=dispatcher, stream=False).run('private prompt', scope='project', bind_strategy=bind_strategy,
                    on_event=on_event,
                    history=[{'role': 'user', 'content': 'previous user message'}]), 10)
            expected_calls = [('weaveclaw_get_creation_progress', {'episode': 2})]
            if scenario == 'script_required':
                expected_calls.append(('weaveclaw_generate_script', {'episode': 2}))
            assert len(bindings) == 1 and len(bindings[0]) == 64
            assert result.write_attempted == (scenario == 'script_required')
            assert model.calls == 2 and dispatcher.calls == expected_calls
            if scenario.startswith('real_'):
                [snapshot] = [event for event in events if event.get('type') == 'creation_progress']
                assert snapshot['project_id'] == 'fixture-project' and snapshot['progress']['episode'] == 2
                assert len(snapshot['progress']['skipped']) == snapshot['progress']['step']
                if scenario == 'real_audio_accepted':
                    assert snapshot['progress']['step'] == 11 and snapshot['progress']['skipped'][-1] == 'audio'
                    assert snapshot['progress']['artifacts']['audio_unknown'] == 1
                    assert snapshot['progress']['artifacts']['audio_confirmed'] == 1
                if scenario == 'real_audio_stale':
                    assert snapshot['progress']['step'] == 10 and snapshot['progress']['skipped'][-1] == 'first_frames'
                    assert snapshot['progress']['artifacts']['audio_stale'] == 1
                if scenario == 'real_quality_failed':
                    assert snapshot['progress']['step'] == 9
        fixture = Dispatcher('real_quality_failed', Path(temp.name) / 'quality-recovery')
        saved_quality = {'ok': True, 'data': await fixture.real_progress()}
        async def replay_quality(_model_id, tool_id, name, args):
            assert name == 'weaveclaw_get_creation_progress' and args == {'episode': 2}
            return {'read_cost': 1, 'result': saved_quality}
        from novelvideo.chat.business_tools import BusinessToolDispatcher
        no_request, no_claim = AsyncMock(), AsyncMock()
        recovery_dispatcher = BusinessToolDispatcher(project_id='fixture-project', request=no_request,
            authorize=AsyncMock(), claim_write=no_claim)
        recovery_model = Model('quality_failed', resumed=True)
        recovery = await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=recovery_model,
            dispatcher=recovery_dispatcher, stream=False, replay_read=replay_quality).run('private prompt', scope='project',
                bind_strategy=bind_strategy, last_episode=2, history=[{'role': 'user', 'content': 'previous user message'}]), 10)
        no_request.assert_not_awaited(); no_claim.assert_not_awaited()
        assert not recovery.write_attempted and recovery_model.calls == 2
        for tool in ('weaveclaw_plan_scenes', 'weaveclaw_plan_props'):
            dispatcher = Dispatcher('real_global_optimize_required', Path(temp.name) / tool)
            model = Model('global_optimize_required', write_tool=tool)
            result = await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=model,
                dispatcher=dispatcher, stream=False).run('plan episode assets', scope='project', bind_strategy=bind_strategy,
                    history=[{'role': 'user', 'content': 'previous user message'}]), 10)
            assert result.write_attempted and model.calls == 2
            assert dispatcher.calls == [('weaveclaw_get_creation_progress', {'episode': 2}), (tool, {'episode': 2})]
        from novelvideo.chat.business_tools import BusinessToolDispatcher, BusinessToolError
        def batch_progress(number, complete):
            ep = {'number': number, 'exists': True, 'identity_planned': True, 'beats': 1 if complete else 0,
                  'all_beats_have_content': complete, 'sketches_missing': 0, 'sketches_stale': 0,
                  'identity_detected': 1 if complete else 0, 'first_frames_present': 1 if complete else 0}
            if complete:
                ep.update(video_prompt_present=1, audio_current=1, audio_stale=0, audio_unknown=0, audio_confirmed=0,
                          video_current=1, video_stale=0, video_unknown=0, video_confirmed=0,
                          composed=True, composed_freshness='current', composition_confirmed=False)
            return {'version': 1, 'source': {'uploads': 1, 'imported': True, 'ingest': 'completed'},
                    'project': {'characters': 1, 'episodes': 2, 'configured': True}, 'episode': ep, 'active_steps': []}
        class VerifyBatchModel(Model):
            async def request(self, messages, settings, parameters):
                self.calls += 1
                if self.calls == 1:
                    return ModelResponse(parts=[ToolCallPart('weaveclaw_get_creation_progress', {'episode': 1}, 'quality-read')], finish_reason='tool_call', model_name='mock')
                assert 'reason=quality_verify_required' in messages[0].parts[0].content
                return ModelResponse(parts=[ToolCallPart('weaveclaw_verify_first_frames', {'episode': 1}, 'quality-submit')], finish_reason='tool_call', model_name='mock')
        quality_batch = {'start': 1, 'end': 2, 'current': 1, 'allow_write': True, 'quality_required': True}
        quality_requests, quality_reads = [], []
        async def quality_request(method, path, *, query=None, body=None):
            quality_requests.append((method, path, body))
            if method == 'GET': return {'ok': True, 'data': batch_progress(1, True)}
            assert body == {'operation': 'frame', 'verify_type': 'frame'}
            return {'ok': True, 'data': {'task_id': 'quality-task', 'task_type': 'verification', 'scope': 'run1', 'status': 'queued'}}
        async def save_quality(call_id, tool_id, name, args, result, cost):
            quality_reads.append({'read_cost': cost, 'result': result})
        claim = AsyncMock(return_value=True)
        dispatcher = BusinessToolDispatcher(project_id='fixture-project', request=quality_request, authorize=AsyncMock(), claim_write=claim)
        quality_result = await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=VerifyBatchModel('quality'),
            dispatcher=dispatcher, stream=False, save_read=save_quality).run('继续批量', scope='project', batch=quality_batch,
                bind_strategy=bind_strategy, history=[{'role': 'user', 'content': 'previous user message'}]), 10)
        assert quality_result.write_attempted and [x[0] for x in quality_requests] == ['GET', 'GET', 'POST']
        claim.assert_awaited_once()
        no_request, no_claim = AsyncMock(), AsyncMock()
        dispatcher = BusinessToolDispatcher(project_id='fixture-project', request=no_request, authorize=AsyncMock(), claim_write=no_claim,
            replay_write=AsyncMock(return_value={'ok': True, 'data': {'task_id': 'quality-task', 'task_type': 'verification', 'scope': 'run1', 'status': 'queued'}}))
        async def replay_quality_batch(*args): return quality_reads[0]
        await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=VerifyBatchModel('quality'),
            dispatcher=dispatcher, stream=False, replay_read=replay_quality_batch).run('继续批量', scope='project', batch=quality_batch,
                bind_strategy=bind_strategy, history=[{'role': 'user', 'content': 'previous user message'}]), 10)
        no_request.assert_not_awaited(); no_claim.assert_not_awaited()
        class BatchModel(Model):
            async def request(self, messages, settings, parameters):
                self.calls += 1
                system = messages[0].parts[0].content
                if self.calls <= 2:
                    assert f'episode={self.calls}; reason=progress_required' in system
                    return ModelResponse(parts=[ToolCallPart('weaveclaw_get_creation_progress', {'episode': self.calls},
                        f'progress-{self.calls}')], finish_reason='tool_call', model_name='mock')
                assert self.calls == 3 and 'episode=2; reason=script_required' in system
                return ModelResponse(parts=[ToolCallPart('weaveclaw_generate_script', {'episode': 2}, 'script')],
                                     finish_reason='tool_call', model_name='mock')
        batch_requests, batch_reads = [], []
        async def batch_request(method, path, *, query=None, body=None):
            batch_requests.append((method, path, query))
            if method == 'GET':
                number = query['episode']
                return {'ok': True, 'data': batch_progress(number, number == 1)}
            return {'ok': True, 'task_id': 'mock-task'}
        async def batch_save(call_id, tool_id, name, args, value, cost):
            batch_reads.append((tool_id, args['episode'], value, cost))
        batch = {'start': 1, 'end': 2, 'current': 1, 'allow_write': True}
        claim = AsyncMock(return_value=True)
        dispatcher = BusinessToolDispatcher(project_id='fixture-project', request=batch_request, authorize=AsyncMock(), claim_write=claim)
        model = BatchModel('batch')
        result = await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=model,
            dispatcher=dispatcher, stream=False, save_read=batch_save).run('继续批量', scope='project', batch=batch,
                bind_strategy=bind_strategy, history=[{'role': 'user', 'content': 'previous user message'}]), 10)
        assert result.write_attempted and model.calls == 3 and [item[0] for item in batch_requests] == ['GET', 'GET', 'POST']
        assert [(item[0], item[1], item[3]) for item in batch_reads] == [('progress-1', 1, 1), ('progress-2', 2, 1)]
        claim.assert_awaited_once()
        # Frozen progress and the accepted write can be replayed without new reads or effects.
        async def batch_replay(call_id, tool_id, name, args):
            item = next(item for item in batch_reads if item[0] == tool_id)
            return {'read_cost': item[3], 'result': item[2]}
        claim, request = AsyncMock(), AsyncMock()
        dispatcher = BusinessToolDispatcher(project_id='fixture-project', request=request, authorize=AsyncMock(),
            claim_write=claim, replay_write=AsyncMock(return_value={'ok': True, 'task_id': 'mock-task'}))
        result = await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=BatchModel('batch'),
            dispatcher=dispatcher, stream=False, replay_read=batch_replay).run('继续批量', scope='project', batch=batch,
                bind_strategy=bind_strategy, history=[{'role': 'user', 'content': 'previous user message'}]), 10)
        assert result.write_attempted and dispatcher.read_count == 2
        claim.assert_not_awaited(); request.assert_not_awaited()
        # Exercise the host auto coordinator against the real Pi protocol with
        # mock models and a task that changes from queued to completed.
        from novelvideo.chat.creation_batch_auto import run_batch_auto
        state = {'id': 'batch-auto', 'start': 1, 'end': 2, 'current': 1, 'last_turn': 'initial'}
        receipts = {'initial': {'status': 'completed', 'tasks': []}}
        auto_events, auto_requests, executions = [], [], []
        polls = 0
        async def auto_load(): return dict(state)
        async def auto_refresh(turn):
            nonlocal polls
            receipt = receipts[turn]
            if turn == 'child-1' and receipt['tasks'][0]['status'] == 'queued':
                polls += 1
                if polls == 2:
                    auto_events.append('task_completed')
                    receipt['tasks'][0]['status'] = 'completed'
            return receipt
        async def auto_notify(status, reason, batch_state, turns): auto_events.append(status)
        class CompleteBatchModel(Model):
            async def request(self, messages, settings, parameters):
                self.calls += 1
                if self.calls == 1:
                    assert 'episode=2; reason=progress_required' in messages[0].parts[0].content
                    return ModelResponse(parts=[ToolCallPart('weaveclaw_get_creation_progress', {'episode': 2}, 'done-read')], finish_reason='tool_call', model_name='mock')
                return ModelResponse(parts=[TextPart('批次完成')], finish_reason='stop', model_name='mock')
        async def auto_execute(batch_state, receipt, resume):
            assert not resume
            executions.append(batch_state['current'])
            async def request_auto(method, path, *, query=None, body=None):
                auto_requests.append((method, path, query))
                if method == 'GET':
                    number = query['episode']
                    complete = number == 1 or len(executions) == 2
                    if complete: state['current'] = number + 1
                    return {'ok': True, 'data': batch_progress(number, complete)}
                return {'ok': True, 'task_id': 'auto-mock-task'}
            child = f'child-{len(executions)}'
            state['last_turn'] = child
            dispatcher_auto = BusinessToolDispatcher(project_id='fixture-project', request=request_auto, authorize=AsyncMock(), claim_write=AsyncMock(return_value=True))
            model_auto = BatchModel('batch') if len(executions) == 1 else CompleteBatchModel('batch')
            result_auto = await OrchestratorRuntime(link=app.state.orchestrator_link, model=model_auto,
                dispatcher=dispatcher_auto, stream=False).run('继续批量', scope='project',
                    batch={'start': 1, 'end': 2, 'current': batch_state['current'], 'allow_write': True},
                    bind_strategy=bind_strategy, history=[{'role': 'user', 'content': 'previous user message'}])
            receipts[child] = {'status': 'completed', 'tasks': ([{'status': 'queued'}] if result_auto.write_attempted else []),
                'operation': ({'state': 'accepted'} if result_auto.write_attempted else None)}
        outcome = await asyncio.wait_for(run_batch_auto(batch_id='batch-auto', load=auto_load, refresh=auto_refresh,
            execute=auto_execute, notify=auto_notify, interval=0.001), 10)
        assert outcome.state == 'completed' and executions == [1, 2]
        assert auto_events.index('waiting') < auto_events.index('task_completed') < len(auto_events) - 1
        assert [item[0] for item in auto_requests] == ['GET', 'GET', 'POST', 'GET']
        recovery_state = {'id': 'recovery', 'start': 1, 'end': 2, 'current': 1, 'last_turn': 'interrupted'}
        recovery_receipt = {'status': 'cancelled', 'version': 3, 'continuation': 'resume',
                            'operation': {'state': 'accepted'}, 'tasks': [{'status': 'queued'}]}
        recovery_calls = []
        async def recovery_load(): return dict(recovery_state)
        async def recovery_refresh(turn): return recovery_receipt
        async def recovery_execute(batch_state, receipt, resume):
            assert resume and batch_state['last_turn'] == 'interrupted'
            recovery_calls.append(batch_state['last_turn'])
            no_new_request, no_new_claim = AsyncMock(), AsyncMock()
            recovery_dispatcher = BusinessToolDispatcher(project_id='fixture-project', request=no_new_request,
                authorize=AsyncMock(), claim_write=no_new_claim, replay_write=AsyncMock(return_value={'ok': True, 'task_id': 'mock-task'}))
            await OrchestratorRuntime(link=app.state.orchestrator_link, model=BatchModel('batch'),
                dispatcher=recovery_dispatcher, stream=False, replay_read=batch_replay).run('继续批量', scope='project',
                    batch=batch, bind_strategy=bind_strategy, history=[{'role': 'user', 'content': 'previous user message'}])
            no_new_claim.assert_not_awaited(); no_new_request.assert_not_awaited()
            recovery_state['current'] = 2
            recovery_receipt.update(status='unknown', operation={'state': 'unknown'})
        recovery_outcome = await asyncio.wait_for(run_batch_auto(batch_id='recovery', load=recovery_load,
            refresh=recovery_refresh, execute=recovery_execute, notify=auto_notify, interval=0.001), 10)
        assert recovery_calls == ['interrupted'] and recovery_outcome.reason == 'receipt_attention'
        class RepairModel(Model):
            def __init__(self, *, valid=False, still_invalid=False):
                super().__init__('repair')
                self.valid, self.still_invalid = valid, still_invalid
            async def request(self, messages, settings, parameters):
                self.calls += 1
                assert 'weaveclaw_update_beat' in {item.name for item in parameters.function_tools}
                args = {'episode': 2, 'beat': 1, 'expected_revision': 'a' * 32}
                if self.valid or self.calls > 1:
                    args['audio_type'] = 'invalid' if self.still_invalid else 'narration'
                if self.calls > 1:
                    errors = [part.content for message in messages for part in message.parts if isinstance(part, ToolReturnPart)
                              and isinstance(part.content, dict) and part.content.get('preflight_only') is True]
                    assert len(errors) == 1
                return ModelResponse(parts=[ToolCallPart('weaveclaw_update_beat', args, f'edit-{self.calls}')],
                                     finish_reason='tool_call', model_name='mock')
        async def retry_request(method, path, *, query=None, body=None):
            assert method == 'PATCH' and body['audio_type'] == 'narration'
            return {'ok': True, 'data': {'saved': True}}
        claim = AsyncMock(return_value=True)
        request = AsyncMock(side_effect=retry_request)
        dispatcher = BusinessToolDispatcher(project_id='fixture-project', request=request, authorize=AsyncMock(), claim_write=claim)
        model = RepairModel()
        result = await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=model,
            dispatcher=dispatcher, stream=False).run('将第一镜头设为旁白', scope='project', bind_strategy=bind_strategy,
                history=[{'role': 'user', 'content': 'previous user message'}]), 10)
        assert result.write_attempted and model.calls == 2
        claim.assert_awaited_once(); request.assert_awaited_once()
        # A saved accepted operation is replayed only for the corrected args.
        claim, request = AsyncMock(), AsyncMock()
        replay = AsyncMock(return_value={'ok': True, 'data': {'saved': True}})
        dispatcher = BusinessToolDispatcher(project_id='fixture-project', request=request, authorize=AsyncMock(),
            claim_write=claim, replay_write=replay)
        result = await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=RepairModel(),
            dispatcher=dispatcher, stream=False).run('将第一镜头设为旁白', scope='project', bind_strategy=bind_strategy,
                history=[{'role': 'user', 'content': 'previous user message'}]), 10)
        assert result.write_attempted and replay.await_args.args[1]['audio_type'] == 'narration'
        claim.assert_not_awaited(); request.assert_not_awaited()
        # An uncertain business timeout after the write claim is never retried.
        claim, request = AsyncMock(return_value=True), AsyncMock(side_effect=TimeoutError())
        dispatcher = BusinessToolDispatcher(project_id='fixture-project', request=request, authorize=AsyncMock(), claim_write=claim)
        model = RepairModel(valid=True)
        try:
            await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=model,
                dispatcher=dispatcher, stream=False).run('将第一镜头设为旁白', scope='project', bind_strategy=bind_strategy,
                    history=[{'role': 'user', 'content': 'previous user message'}]), 10)
        except TimeoutError:
            assert model.calls == 1 and dispatcher.write_attempted
            claim.assert_awaited_once(); request.assert_awaited_once()
        else:
            raise AssertionError('business timeout must stop the turn')
        fixture = Dispatcher('real_config_recommendation', Path(temp.name) / 'config-recommendation')
        events, requests, claim = [], [], AsyncMock(return_value=True)
        async def config_request(method, path, *, query=None, body=None):
            requests.append((method, path))
            assert method == 'GET'
            if path.endswith('/creation/progress'):
                return {'ok': True, 'data': await fixture.real_progress()}
            from novelvideo.services.creation_config_recommendations import context
            ctx = SimpleNamespace(project_id='fixture-project', output_dir=fixture.root / fixture.scenario / 'output',
                state_dir=fixture.root / fixture.scenario / 'state', owner_username='fixture', project_name='fixture')
            return {'ok': True, 'data': context(ctx)}
        class RecommendationModel(Model):
            async def request(self, messages, settings, parameters):
                self.calls += 1
                names = {item.name for item in parameters.function_tools}
                if self.calls == 1:
                    assert 'weaveclaw_get_config_recommendation_context' not in names
                    return ModelResponse(parts=[ToolCallPart('weaveclaw_get_creation_progress', {'episode': 2}, 'read')], finish_reason='tool_call', model_name='mock')
                if self.calls == 2:
                    assert 'reason=config_recommendation' in messages[0].parts[0].content
                    assert 'weaveclaw_get_config_recommendation_context' in names and 'weaveclaw_propose_config_recommendation' not in names
                    return ModelResponse(parts=[ToolCallPart('weaveclaw_get_config_recommendation_context', {'episode': 2}, 'context')], finish_reason='tool_call', model_name='mock')
                if self.calls == 3:
                    item = next(part.content['data'] for message in messages for part in message.parts
                        if isinstance(part, ToolReturnPart) and isinstance(part.content, dict) and 'source_excerpt' in part.content.get('data', {}))
                    assert item['source_excerpt'] == 'fixture' and 'weaveclaw_propose_config_recommendation' in names
                    args = {'episode': 2, 'source_sha256': item['source_sha256'], 'expected_revision': item['expected_revision'],
                        'visual_style': 'anime', 'narration_style': 'third_person', 'ethnicity': 'Chinese', 'rhythm': 'medium', 'reason': '根据片段建议'}
                    return ModelResponse(parts=[ToolCallPart('weaveclaw_propose_config_recommendation', args, 'proposal')], finish_reason='tool_call', model_name='mock')
                assert self.calls == 4
                return ModelResponse(parts=[TextPart('请查看并选择建议')], finish_reason='stop', model_name='mock')
        async def config_event(event):
            events.append(event)
        dispatcher = BusinessToolDispatcher(project_id='fixture-project', request=config_request, authorize=AsyncMock(), claim_write=claim)
        model = RecommendationModel('config_recommendation')
        from novelvideo.services.style_service import StyleService
        with patch.object(StyleService, 'get_style_labels', return_value={'anime': '动画'}):
            result = await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=model,
                dispatcher=dispatcher, stream=False).run('给出配置建议', scope='project', bind_strategy=bind_strategy,
                    on_event=config_event, history=[{'role': 'user', 'content': 'previous user message'}]), 10)
        [proposed] = [event for event in events if event.get('type') == 'tool_result' and event.get('name') == 'weaveclaw_propose_config_recommendation']
        assert proposed['fresh'] and proposed['result']['data']['recommendations']['visual_style'] == 'anime'
        assert 'source_excerpt' not in proposed['result']['data'] and not result.write_attempted
        claim.assert_not_awaited()
        assert all(method == 'GET' for method, _ in requests)
        # Real dispatcher, authenticated local transport and simulated model:
        # neither read can finish until both have entered the request handler.
        entered, both, saved = [], asyncio.Event(), []
        async def parallel_request(method, path, *, query=None, body=None):
            assert method == 'GET'
            entered.append(path)
            if len(entered) == 2:
                both.set()
            await asyncio.wait_for(both.wait(), 3)
            if path.endswith('/characters'):
                await asyncio.sleep(0.02)
            return {'ok': True, 'data': [{'path': path}]}
        async def save_parallel(_model_id, tool_id, name, args, value, cost):
            saved.append((tool_id, name, cost))
        class ParallelModel(Model):
            async def request(self, messages, settings, parameters):
                self.calls += 1
                if self.calls == 1:
                    names = {item.name for item in parameters.function_tools}
                    assert {'weaveclaw_list_characters', 'weaveclaw_list_episodes'} <= names
                    return ModelResponse(parts=[ToolCallPart('weaveclaw_list_characters', {}, 'characters'),
                        ToolCallPart('weaveclaw_list_episodes', {}, 'episodes')], finish_reason='tool_call', model_name='mock')
                returns = [part.tool_call_id for message in messages for part in message.parts if isinstance(part, ToolReturnPart)]
                assert returns == ['characters', 'episodes']
                return ModelResponse(parts=[TextPart('已读取角色和分集')], finish_reason='stop', model_name='mock')
        claim = AsyncMock(return_value=True)
        dispatcher = BusinessToolDispatcher(project_id='fixture-project', request=parallel_request,
            authorize=AsyncMock(), claim_write=claim)
        model = ParallelModel('parallel')
        result = await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=model,
            dispatcher=dispatcher, stream=False, save_read=save_parallel).run('查看角色和分集', scope='project',
                bind_strategy=bind_strategy, history=[{'role': 'user', 'content': 'previous user message'}]), 10)
        assert len(entered) == 2 and dispatcher.read_count == 2 and not result.write_attempted
        assert saved == [('characters', 'weaveclaw_list_characters', 1), ('episodes', 'weaveclaw_list_episodes', 1)]
        claim.assert_not_awaited()
        # One encrypted read is replayed and the other is freshly fetched;
        # each still consumes exactly one read and no replay causes a GET.
        fresh_requests, replay_saved = [], []
        async def fresh_request(method, path, *, query=None, body=None):
            fresh_requests.append(path)
            return {'ok': True, 'data': [{'path': path}]}
        async def replay_parallel(_model_id, tool_id, name, args):
            return {'read_cost': 1, 'result': {'ok': True, 'data': []}} if tool_id == 'characters' else None
        async def save_fresh(_model_id, tool_id, name, args, value, cost):
            replay_saved.append((tool_id, cost))
        claim = AsyncMock(return_value=True)
        dispatcher = BusinessToolDispatcher(project_id='fixture-project', request=fresh_request,
            authorize=AsyncMock(), claim_write=claim)
        result = await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=ParallelModel('parallel'),
            dispatcher=dispatcher, stream=False, replay_read=replay_parallel, save_read=save_fresh).run('查看角色和分集',
                scope='project', bind_strategy=bind_strategy, history=[{'role': 'user', 'content': 'previous user message'}]), 10)
        assert len(fresh_requests) == 1 and fresh_requests[0].endswith('/episodes')
        assert dispatcher.read_count == 2 and replay_saved == [('episodes', 1)] and not result.write_attempted
        claim.assert_not_awaited()
        for changed in (False, True):
            fixture = Dispatcher('real_resume', Path(temp.name) / f'audio-recheck-{changed}')
            requests, claim = [], AsyncMock(return_value=True)
            async def media_request(method, path, *, query=None, body=None):
                requests.append((method, path))
                if method == 'GET':
                    if changed and len(requests) == 2:
                        # An identical edit still advances the beat revision and
                        # invalidates the earlier user decision for unknown audio.
                        with closing(sqlite3.connect(fixture.resume_context[0].state_dir / 'data.db')) as db:
                            db.execute('UPDATE beats SET narration=narration WHERE episode_number=2 AND beat_number=1')
                            db.commit()
                    return {'ok': True, 'data': await fixture.real_progress()}
                return {'ok': True, 'task_id': 'fixture-task'}
            dispatcher = BusinessToolDispatcher(project_id='fixture-project', request=media_request,
                authorize=AsyncMock(), claim_write=claim)
            model = Model('video_required', write_tool='weaveclaw_start_single_video')
            with patch('novelvideo.chat.business_tools._plan_allows_tool', return_value=True), \
                    patch('novelvideo.chat.business_tools.preflight_tool_dependencies'):
                runtime = OrchestratorRuntime(link=app.state.orchestrator_link, model=model,
                    dispatcher=dispatcher, stream=False)
                try:
                    result = await asyncio.wait_for(runtime.run('generate video', scope='project',
                        bind_strategy=bind_strategy, history=[{'role': 'user', 'content': 'previous user message'}]), 10)
                except BusinessToolError as exc:
                    assert changed and str(exc) == 'media_progress_required'
                    claim.assert_not_awaited()
                    assert [method for method, _ in requests] == ['GET', 'GET']
                else:
                    assert not changed and result.write_attempted
                    claim.assert_awaited_once()
                    assert [method for method, _ in requests] == ['GET', 'GET', 'POST']
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
        print('Python–Pi local WebSocket: verified planner gates, audio recheck, resume and media changes')
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

import asyncio
import json
import os
import socket
import shutil
from pathlib import Path
from types import SimpleNamespace

import uvicorn
from fastapi import FastAPI
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ToolReturnPart

from novelvideo.api.routes.desktop_orchestrator import router
from novelvideo.chat.orchestrator_link import OrchestratorLink
from novelvideo.chat.orchestrator_runtime import OrchestratorRuntime
from novelvideo.chat.business_tools import TOOL_SPECS

ELECTRON = os.environ.get('WEAVECLAW_TEST_ELECTRON')
NODE = ELECTRON or os.environ.get('WEAVECLAW_TEST_NODE') or shutil.which('node')
CLIENT = str(Path(__file__).with_name('electron-python-host.cjs' if ELECTRON else 'python-host-client.mjs'))
if not NODE:
    raise RuntimeError('Node.js or Electron is required for this development test')

class Model:
    profile = SimpleNamespace(supports_tools=True)
    def __init__(self): self.calls = 0
    async def request(self, messages, settings, parameters):
        self.calls += 1
        assert 'Work toward one episode in order' in messages[0].parts[0].content
        assert 'host controls identity' in messages[0].parts[0].content
        assert messages[1].parts[0].content == 'previous user message'
        if self.calls == 1:
            assert 'dramaclaw_generate_script' not in {item.name for item in parameters.function_tools}
            return ModelResponse(parts=[TextPart('先读取素材'), ToolCallPart('dramaclaw_get_creation_progress', {'episode': 2}, 'read-1')],
                                 finish_reason='tool_call', model_name='mock')
        assert 'dramaclaw_generate_script' in {item.name for item in parameters.function_tools}
        assert 'reason=script_required' in messages[0].parts[0].content
        assert any(isinstance(part, ToolReturnPart) and part.content['data']['episode']['number'] == 2
                   for message in messages for part in message.parts)
        return ModelResponse(parts=[ToolCallPart('dramaclaw_generate_script', {'episode': 2}, 'call-1')],
                             finish_reason='tool_call', model_name='mock')

class Dispatcher:
    def __init__(self): self.write_attempted = False; self.calls = []
    def definitions(self):
        real_tools = [SimpleNamespace(name=spec.name, description=spec.description, parameters_json_schema=spec.schema)
                      for spec in TOOL_SPECS.values()]
        return real_tools
    def validate(self, name, args):
        assert name in ('dramaclaw_get_creation_progress', 'dramaclaw_generate_script') and args == {'episode': 2}
        return SimpleNamespace(writes=name == 'dramaclaw_generate_script')
    async def dispatch(self, name, args):
        self.calls.append((name, args))
        if name == 'dramaclaw_get_creation_progress':
            return {'ok': True, 'data': {'version': 1, 'source': {'uploads': 1, 'imported': True},
                'project': {'characters': 1, 'episodes': 1},
                'episode': {'number': 2, 'exists': True, 'identity_planned': True, 'beats': 0,
                    'all_beats_have_content': False, 'sketches_missing': 0, 'sketches_stale': 0,
                    'identity_detected': 0, 'first_frames_present': 0}, 'active_steps': []}}
        self.write_attempted = True
        return {'ok': True, 'result': 'verified'}

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
        dispatcher, model = Dispatcher(), Model()
        bindings = []
        async def bind_strategy(digest):
            bindings.append(digest)
        result = await asyncio.wait_for(OrchestratorRuntime(link=app.state.orchestrator_link, model=model,
            dispatcher=dispatcher, stream=False).run('private prompt', scope='project', bind_strategy=bind_strategy,
                history=[{'role': 'user', 'content': 'previous user message'}]), 10)
        assert len(bindings) == 1 and len(bindings[0]) == 64
        assert result.write_attempted and model.calls == 2 and dispatcher.calls == [
            ('dramaclaw_get_creation_progress', {'episode': 2}), ('dramaclaw_generate_script', {'episode': 2})]
        print('Python–Pi local WebSocket: verified read, continuation and one host-owned write')
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

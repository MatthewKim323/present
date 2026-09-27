import json
import pytest
from perception.service import Hub
from perception.panels import PanelStore

class Socket:
    def __init__(self):
        self.messages = []
    async def send_text(self, data):
        self.messages.append(json.loads(data))
    async def send_json(self, data):
        self.messages.append(data)

@pytest.mark.asyncio
async def test_reconnect_restores_latest_cockpit_without_actions_or_toasts():
    hub = Hub()
    panels = PanelStore(hub.broadcast)
    await hub.broadcast({'kind': 'qm_swarm', 'event_id': 'a', 'state': 'running'})
    await hub.broadcast({'kind': 'qm_swarm', 'event_id': 'a', 'state': 'done'})
    await hub.broadcast({'kind': 'preview_shot', 'job_id': 'a', 'jpeg_b64': 'image'})
    await hub.broadcast({'kind': 'memory_event', 'text': 'APPROVED'})
    await hub.broadcast({'kind': 'dev_action', 'action': 'approve', 'pr': 1})
    ws = Socket()
    await panels.connect(ws, hub.clients, replay=hub.replay)
    assert [m['kind'] for m in ws.messages] == ['qm_swarm', 'preview_shot']
    assert ws.messages[0]['state'] == 'done'
    assert ws in hub.clients
    await hub.broadcast({'kind': 'dev_github', 'prs': []})
    assert ws.messages[-1]['kind'] == 'dev_github'
    await hub.broadcast({'kind': 'clear'})
    other = Socket()
    await hub.replay(other)
    assert other.messages == []

@pytest.mark.asyncio
async def test_expired_snapshots_are_not_replayed():
    hub = Hub()
    hub._state['preview_shot'] = (0, json.dumps({'kind':'preview_shot'}))
    ws = Socket()
    await hub.replay(ws)
    assert ws.messages == []
    assert hub._state == {}

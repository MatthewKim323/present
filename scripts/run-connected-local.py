"""Run WORLD locally with backend-only credentials from .env.integrations."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def load(path, only=None):
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        if only is None or key in only:
            os.environ.setdefault(key, value.strip().strip('"\''))

load(ROOT / '.env.integrations')
# Reuse the existing local QM deployment; never copy its admin credentials.
load(Path(os.environ.get('WORLD_QM_ENV', str(Path.home() / 'dev/qm/qm.env'))), {'WORLD_HOOKS_SECRET'})
for key, value in {
    'QM_URL': 'http://127.0.0.1:8091', 'GBRAIN_MODE': 'stub',
    'GBRAIN_ENV_PATH': '/dev/null', 'BUILDER_AUTO': '0', 'DEVFEED': '0',
    'WORLD_PEOPLE_PATH': str(ROOT / 'perception/data/people.json'),
    'WORLD_EVENTS_LOG': str(ROOT / 'perception/data/events.jsonl'),
}.items():
    os.environ.setdefault(key, value)

if __name__ == '__main__':
    import uvicorn
    from perception.service import WorldService, create_app
    uvicorn.run(create_app(WorldService()), host='127.0.0.1', port=int(os.environ.get('WORLD_PORT', '8790')), ws_max_size=16 * 1024 * 1024)

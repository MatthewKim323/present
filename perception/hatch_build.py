"""Bundle the repository panel contract in wheels and source distributions."""
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        root = Path(self.root)
        # Repository checkout, or a source distribution's bundled contract.
        manifest = root.parent / "contracts" / "PANELS.json"
        if not manifest.is_file():
            manifest = root / "contracts" / "PANELS.json"
        if not manifest.is_file():
            raise FileNotFoundError("The shared contracts/PANELS.json is required to build perception")
        destination = "perception/PANELS.json" if self.target_name == "wheel" else "contracts/PANELS.json"
        build_data.setdefault("force_include", {})[str(manifest)] = destination

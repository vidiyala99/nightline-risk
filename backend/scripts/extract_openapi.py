import json
import sys
from pathlib import Path

# Add backend dir first so we import this repository's app package.
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.main import app

# Ensure we use the root project directory for the output
output_path = Path(__file__).parent.parent.parent / "openapi.json"

with open(output_path, "w") as f:
    json.dump(app.openapi(), f, indent=2)
print(f"Saved openapi.json to {output_path}")

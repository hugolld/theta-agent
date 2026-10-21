"""Entry point: `uv run python -m theta_compute` (see gateway/README.md)."""

import sys

from .server import main

if __name__ == "__main__":
	sys.exit(main())

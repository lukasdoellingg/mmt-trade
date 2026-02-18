#!/usr/bin/env python3
"""
MMT-Trade Bot – Einstiegspunkt.
Startet die TUI (Terminal-UI, Hacker-Style). Für grafisches GUI: python -c "from src.gui import App; App().run()"
"""

import sys
from pathlib import Path

# Projektroot für Imports
root = Path(__file__).resolve().parent
if str(root) not in sys.path:
    sys.path.insert(0, str(root))

from src.tui import MMTTradeTUI


def main() -> None:
    app = MMTTradeTUI()
    app.run()


if __name__ == "__main__":
    main()

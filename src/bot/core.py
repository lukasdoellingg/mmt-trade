"""
Bot-Kernlogik – Platzhalter für spätere Trading-/Automations-Logik.
"""


class Bot:
    """Hauptklasse des Bots. Wird von der GUI gesteuert."""

    def __init__(self) -> None:
        self._running = False

    @property
    def is_running(self) -> bool:
        return self._running

    def start(self) -> None:
        self._running = True

    def stop(self) -> None:
        self._running = False

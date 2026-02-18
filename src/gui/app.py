"""
Modernes GUI für den MMT-Trade Bot.
CustomTkinter – Dark Theme, klare Struktur, erweiterbar.
"""

import customtkinter as ctk

# Erscheinungsbild: dunkel, moderne Schriftgrößen
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")


class App(ctk.CTk):
    def __init__(self):
        super().__init__()

        self.title("MMT-Trade Bot")
        self.geometry("1000x640")
        self.minsize(800, 500)

        # Farben für konsistentes Design
        self.sidebar_bg = ("#1a1a2e", "#16213e")
        self.card_bg = ("#252542", "#1f2b4d")
        self.accent = "#0f3460"
        self.text_secondary = ("#8b8b9e", "#a0a0b8")

        self._build_sidebar()
        self._build_main_content()

    def _build_sidebar(self) -> None:
        self.sidebar = ctk.CTkFrame(
            self,
            width=220,
            corner_radius=0,
            fg_color=self.sidebar_bg,
            border_width=0,
        )
        self.sidebar.pack(side="left", fill="y")
        self.sidebar.pack_propagate(False)

        # Logo / Titel
        title = ctk.CTkLabel(
            self.sidebar,
            text="MMT-Trade",
            font=ctk.CTkFont(family="Segoe UI", size=22, weight="bold"),
            text_color=("white", "white"),
        )
        title.pack(pady=(28, 8), padx=20, anchor="w")

        subtitle = ctk.CTkLabel(
            self.sidebar,
            text="Bot Control",
            font=ctk.CTkFont(size=13),
            text_color=self.text_secondary,
        )
        subtitle.pack(pady=(0, 32), padx=20, anchor="w")

        # Navigation
        self._nav_btn("Dashboard", selected=True)
        self._nav_btn("Einstellungen")
        self._nav_btn("Logs")

        # Status am unteren Rand der Sidebar
        self.status_frame = ctk.CTkFrame(
            self.sidebar,
            fg_color="transparent",
            corner_radius=8,
        )
        self.status_frame.pack(side="bottom", fill="x", padx=16, pady=16)

        self.status_label = ctk.CTkLabel(
            self.status_frame,
            text="● Bereit",
            font=ctk.CTkFont(size=12),
            text_color=("#6bcb77", "#6bcb77"),
        )
        self.status_label.pack(anchor="w")

    def _nav_btn(self, text: str, selected: bool = False) -> None:
        btn = ctk.CTkButton(
            self.sidebar,
            text=text,
            font=ctk.CTkFont(size=14),
            height=40,
            corner_radius=8,
            fg_color=self.accent if selected else "transparent",
            hover_color=("#1a3a5c", "#1a3a5c") if selected else ("#2a2a4a", "#2a3a5a"),
            anchor="w",
            text_color=("white", "white"),
        )
        btn.pack(fill="x", padx=12, pady=4)

    def _build_main_content(self) -> None:
        self.main = ctk.CTkFrame(
            self,
            fg_color=("#1e1e2e", "#1e1e2e"),
            corner_radius=0,
            border_width=0,
        )
        self.main.pack(side="left", fill="both", expand=True, padx=0, pady=0)

        # Kopfzeile
        header = ctk.CTkFrame(self.main, fg_color="transparent")
        header.pack(fill="x", padx=28, pady=(28, 16))

        ctk.CTkLabel(
            header,
            text="Dashboard",
            font=ctk.CTkFont(family="Segoe UI", size=26, weight="bold"),
            text_color=("white", "white"),
        ).pack(side="left")

        # Kartenbereich
        cards = ctk.CTkFrame(self.main, fg_color="transparent")
        cards.pack(fill="both", expand=True, padx=28, pady=(0, 28))

        # Start/Stop Karte
        card1 = ctk.CTkFrame(
            cards,
            corner_radius=16,
            fg_color=self.card_bg,
            border_width=1,
            border_color=("#333355", "#2a3a5a"),
            height=140,
        )
        card1.pack(fill="x", pady=(0, 16))
        card1.pack_propagate(False)

        ctk.CTkLabel(
            card1,
            text="Bot steuern",
            font=ctk.CTkFont(size=16, weight="bold"),
            text_color=("white", "white"),
        ).pack(anchor="w", padx=24, pady=(20, 8))

        btn_frame = ctk.CTkFrame(card1, fg_color="transparent")
        btn_frame.pack(anchor="w", padx=24, pady=(0, 20))

        self.start_btn = ctk.CTkButton(
            btn_frame,
            text="Start",
            width=100,
            height=36,
            corner_radius=8,
            fg_color=("#6bcb77", "#5ab868"),
            hover_color=("#5ab868", "#4a9a56"),
            command=self._on_start,
        )
        self.start_btn.pack(side="left", padx=(0, 10))

        self.stop_btn = ctk.CTkButton(
            btn_frame,
            text="Stopp",
            width=100,
            height=36,
            corner_radius=8,
            fg_color=("#e74c3c", "#c0392b"),
            hover_color=("#c0392b", "#a93226"),
            state="disabled",
            command=self._on_stop,
        )
        self.stop_btn.pack(side="left")

        # Info-Karte
        card2 = ctk.CTkFrame(
            cards,
            corner_radius=16,
            fg_color=self.card_bg,
            border_width=1,
            border_color=("#333355", "#2a3a5a"),
            height=120,
        )
        card2.pack(fill="x", pady=(0, 16))
        card2.pack_propagate(False)

        ctk.CTkLabel(
            card2,
            text="Willkommen beim MMT-Trade Bot",
            font=ctk.CTkFont(size=16, weight="bold"),
            text_color=("white", "white"),
        ).pack(anchor="w", padx=24, pady=(20, 6))

        ctk.CTkLabel(
            card2,
            text="Starte den Bot über die Schaltfläche oben. Einstellungen und Logs findest du in der Sidebar.",
            font=ctk.CTkFont(size=13),
            text_color=self.text_secondary,
            wraplength=700,
            justify="left",
        ).pack(anchor="w", padx=24, pady=(0, 20))

        # Log-Vorschau (Platzhalter)
        log_card = ctk.CTkFrame(
            cards,
            corner_radius=16,
            fg_color=self.card_bg,
            border_width=1,
            border_color=("#333355", "#2a3a5a"),
        )
        log_card.pack(fill="both", expand=True, pady=(0, 0))
        log_card.pack_propagate(True)

        ctk.CTkLabel(
            log_card,
            text="Log",
            font=ctk.CTkFont(size=16, weight="bold"),
            text_color=("white", "white"),
        ).pack(anchor="w", padx=24, pady=(20, 8))

        self.log_text = ctk.CTkTextbox(
            log_card,
            font=ctk.CTkFont(family="Consolas", size=12),
            fg_color=("#1a1a2a", "#1a1a2a"),
            border_width=0,
            corner_radius=8,
            wrap="word",
        )
        self.log_text.pack(fill="both", expand=True, padx=24, pady=(0, 24))
        self.log_text.insert("1.0", "[Bereit] Bot wurde gestartet. Warte auf Start-Befehl.\n")
        self.log_text.configure(state="disabled")

    def _on_start(self) -> None:
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self.status_label.configure(text="● Läuft", text_color=("#6bcb77", "#6bcb77"))
        self._log("Bot gestartet.")

    def _on_stop(self) -> None:
        self.start_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")
        self.status_label.configure(text="● Bereit", text_color=("#6bcb77", "#6bcb77"))
        self._log("Bot gestoppt.")

    def _log(self, message: str) -> None:
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"{message}\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def run(self) -> None:
        self.mainloop()

# Tourwetter

Statische PWA (HTML/CSS/JS ohne Build), ausgeliefert über GitHub Pages von `main` / Root.

- Vor dem ersten Commit in einem frischen Clone: `git config core.hooksPath .githooks`.
  Der pre-commit-Hook schreibt den Commit-Zeitpunkt nach `version.js`; die App zeigt daraus unten an, wie alt der laufende Stand ist.
- Bei Änderungen an App-Dateien `CACHE` in `sw.js` hochzählen.
- Reine Logik in `app.js` ist per `require` in Node testbar (`module.exports` am Ende des Logikteils).
- Oberer Rand (iOS-PWA): Die Kopfleiste `.topbar` ist `position: fixed`, voll breit, einfarbig deckend und schließt den
  Statusleistenbereich ein; `body` ist `position: fixed; inset: 0`. Statusleiste `default`, `html`-Hintergrund = Kopfleistenfarbe.
  Keine Transparenz/Blur an der oberen Kante, sonst blendet iOS einen verwaschenen Verlauf ein (gelöst wie in mhuhn/voka 877e63a).

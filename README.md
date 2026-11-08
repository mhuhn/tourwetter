# Tourwetter

PWA, die für eine GPX-Route das Wetter entlang der Strecke für verschiedene Abfahrtszeiten zeigt.

**App:** https://mhuhn.github.io/tourwetter/

## Bedienung

1. Route in komoot als GPX exportieren, Inhalt kopieren.
2. In Tourwetter auf **GPX einfügen** tippen (liest die Zwischenablage; alternativ Datei öffnen im Menü).
3. Die Matrix zeigt pro Zelle Temperatur (°C), Regen (mm/h) und Wind (km/h).
   - **Zeilen:** Tourpunkte alle 15 min Fahrzeit. Enthält die GPX plausible `<time>`-Angaben, wird die Fahrzeit daraus übernommen; sonst wird mit der Ø-Geschwindigkeit aus dem Menü geschätzt (Standard 20 km/h) und ein Hinweis angezeigt.
   - **Spalten:** Abfahrt jetzt, +1 h, … +23 h (Kopf auf 30 min gerundet).
4. Zoomen per Pinch (Finger übereinander: Punkte, nebeneinander: Stunden) oder über die Buttons 1×/2×/4×/8×.
   Beim Zusammenfassen gilt: liegt das Maximum über 22 °C, wird die höchste Temperatur gezeigt, sonst die niedrigste; Regen und Wind werden gemittelt.

## Technik

- Reines HTML/CSS/JS, kein Build-Schritt, gehostet über GitHub Pages.
- Wetterdaten: [Open-Meteo](https://open-meteo.com/) (`temperature_2m`, `precipitation`, `wind_speed_10m`), mit Höhe aus der GPX zur Temperaturkorrektur.
- Ausgewertet werden alle `trk` / `trkseg` / `trkpt`-Einträge.

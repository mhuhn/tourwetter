# Tourwetter

PWA, die für eine GPX-Route das Wetter entlang der Strecke für verschiedene Abfahrtszeiten zeigt.

**App:** https://mhuhn.github.io/tourwetter/

## Bedienung

1. Route in komoot als GPX exportieren, Inhalt kopieren.
2. In Tourwetter auf **GPX einfügen** tippen (liest die Zwischenablage; alternativ Datei öffnen im Menü).
3. Die Matrix zeigt pro Zelle: Temperatur als Farbe (unter 20 °C blau, über 25 °C rot-orange – aufgespreizt auf die tatsächliche Spanne der Matrix, mind. 3 °C), Regen als diagonale Schraffur und Wind als Keil vom oberen Zellrand (größer bei mehr Wind). Antippen bzw. Hovern blendet für Zeile und Spalte die Zahlen (°C · mm/h · km/h) ein.
   - **Wegpunkte** (`wpt`) mit Flaggen-Symbol (`<sym>` beginnt mit „Flag“) erscheinen als eigene, benannte Zeilen; Regelpunkte näher als 10 min daran entfallen.
   - **Pausen:** Zeilenkopf antippen → Pause nach diesem Punkt in 1-h-Schritten (+/−). Die folgenden Zeilen zeigen dann das Wetter zur entsprechend späteren Ankunft.
   - **Uhrzeit-Pausen:** Spaltenkopf antippen → Pause nach dieser Abfahrtsspalte, also eine Stunde später (Spalte 22:00 → Pause um 23:00, z. B. 7 h). Jede Abfahrt davor pausiert dann um diese Uhrzeit; Punkte danach werden entsprechend später erreicht.
   - **Demo:** Mit `?demo` in der URL wird zusätzlich simulierter Regen in die Daten gemischt.
   - **Zeilen:** Tourpunkte alle 15 min Fahrzeit. Enthält die GPX plausible `<time>`-Angaben, wird die Fahrzeit daraus übernommen; sonst wird mit der Ø-Geschwindigkeit aus dem Menü geschätzt (Standard 20 km/h) und ein Hinweis angezeigt.
   - **Spalten:** Abfahrt jetzt, +1 h, … +23 h (Kopf auf 30 min gerundet).
4. Zoomen per Pinch (Finger übereinander: Punkte, nebeneinander: Stunden) oder über die Buttons 1×/2×/4×/8×.
   Beim Zusammenfassen gilt: liegt das Maximum über 22 °C, wird die höchste Temperatur gezeigt, sonst die niedrigste; Regen und Wind werden gemittelt.

## Technik

- Reines HTML/CSS/JS, kein Build-Schritt, gehostet über GitHub Pages.
- Wetterdaten: [Open-Meteo](https://open-meteo.com/) (`temperature_2m`, `precipitation`, `wind_speed_10m`), mit Höhe aus der GPX zur Temperaturkorrektur.
- Ausgewertet werden alle `trk` / `trkseg` / `trkpt`-Einträge.

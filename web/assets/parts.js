// parts.js — EDITABLE character config for TUX SMASH ROYALE. Single global:
// ClobiParts. The pixel ART now lives in image files under web/assets/tex/
// (baked by tools/gen-textures.mjs and loaded by textures.js). THIS file only
// holds the colour-picker presets + the default looks, which are easy to tweak.
//
// To add styles (shirts, hats, beards, capes...) edit tools/gen-textures.mjs and
// re-run it; the new image + manifest entry shows up in the editor automatically.
window.ClobiParts = {
  GRID_W: 64,
  GRID_H: 72,

  // Colour-picker preset swatches (the editor also offers a free colour picker).
  presets: {
    skin:  ['#ffe0bd', '#f3c69a', '#e0a878', '#c68642', '#8d5524', '#5a3a22'],
    hair:  ['#b07a43', '#7a4a1f', '#3a2a18', '#11131c', '#d9b15a', '#a0522d', '#c0392b', '#cfd4e0'],
    body:  ['#11131c', '#1b2a4a', '#3a1d4a', '#143a2a', '#4a1320', '#2b2b2b', '#103a44', '#3a2a10'],
    belly: ['#fdfdfd', '#7ff9e0', '#ffe7b0', '#ffd0e0', '#cfe9ff', '#d8ffcf', '#fff27f', '#e8e8f0'],
    shirt: ['#fdfdfd', '#7ff9e0', '#2b5fff', '#ff5a3c', '#1b7a3a', '#3a1d4a', '#fff27f', '#11131c'],
    pants: ['#33405c', '#222634', '#5a3a22', '#11131c', '#3a1d4a', '#1b3a2a', '#6a2a2a', '#8a8f9e'],
    feet:  ['#ff9e2c', '#5a3a22', '#11131c', '#ff5a3c', '#7ff9e0', '#9cff5a', '#ffffff', '#b06a2c'],
    beard: ['#7a4a1f', '#b07a43', '#3a2a18', '#11131c', '#d9b15a', '#cfd4e0'],
    cape:  ['#ff5a3c', '#7ff9e0', '#7a52d0', '#ffcf3c', '#1b7a3a', '#e8e8f0', '#11131c', '#ff7fbf'],
    iris:  ['#222a3a', '#3a6a9a', '#2a6a3a', '#6a4a2a', '#5a3a8a', '#7a2a2a', '#111111', '#8a6a3a'],
    mouth: ['#a86a5a', '#9a5a4a', '#7a4a3a', '#b07a6a', '#7a3a3a', '#6a3a2a'],
  },

  // Default HUMANOID = Clobi himself: light-brown ponytail, small framed beard,
  // white "Hemd" (shirt), brown shoes. Indices match the manifest catalog order.
  clobi: {
    gender: 'male',
    skin: '#f3c69a', hairColor: '#b07a43', beardColor: '#7a4a1f',
    belly: '#fdfdfd', feet: '#5a3a22', pants: '#33405c',
    hair: 1 /* Short */, beard: 3 /* Full */,
    shirtStyle: 5 /* Suit */, pantsStyle: 0, shoeStyle: 0
  }
};

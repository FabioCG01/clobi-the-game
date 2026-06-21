// parts.js — EDITABLE character art data for TUX SMASH ROYALE.
// =============================================================================
// This file is meant to be tweaked! Add hairstyles, beards, hats, or colours
// here and they show up in the editor automatically — no other code changes.
//
// Art grid: 32 wide x 36 tall (2x the old resolution => more detail/freedom).
// Heads sit around x=11..21, y=3..13 (centre x=16). The renderer (sprites.js)
// composes a character from this data, resolving colours per fighter.
//
// Pixel parts are lists of rectangles: [x, y, w, h].
//   - hair[] rects are painted in the fighter's HAIR colour.
//   - beard[] rects are painted in the fighter's BEARD colour.
// Catalog parts (hats/eyes/accessories/capes) carry their own fixed colours.
// =============================================================================
window.ClobiParts = {
  GRID_W: 32,
  GRID_H: 36,

  // Colour-picker preset swatches (the editor also offers a free colour picker).
  presets: {
    skin:  ['#ffe0bd', '#f3c69a', '#e0a878', '#c68642', '#8d5524', '#5a3a22'],
    hair:  ['#b07a43', '#7a4a1f', '#3a2a18', '#11131c', '#d9b15a', '#a0522d', '#c0392b', '#cfd4e0'],
    body:  ['#11131c', '#1b2a4a', '#3a1d4a', '#143a2a', '#4a1320', '#2b2b2b', '#103a44', '#3a2a10'],
    belly: ['#fdfdfd', '#7ff9e0', '#ffe7b0', '#ffd0e0', '#cfe9ff', '#d8ffcf', '#fff27f', '#e8e8f0'],
    shirt: ['#fdfdfd', '#7ff9e0', '#2b5fff', '#ff5a3c', '#1b7a3a', '#3a1d4a', '#fff27f', '#11131c'],
    feet:  ['#ff9e2c', '#5a3a22', '#11131c', '#ff5a3c', '#7ff9e0', '#9cff5a', '#ffffff', '#b06a2c'],
    beard: ['#7a4a1f', '#b07a43', '#3a2a18', '#11131c', '#d9b15a', '#cfd4e0'],
  },

  // The default HUMANOID look = Clobi himself: light-brown ponytail, a small
  // beard around the mouth, and a white "Hemd" (shirt).
  clobi: {
    gender: 'male',
    skin: '#f3c69a',
    hairColor: '#b07a43',
    beardColor: '#7a4a1f',
    belly: '#fdfdfd', // white shirt
    feet: '#5a3a22',  // brown shoes
    hair: 0,          // Ponytail (index 0 below)
    beard: 1          // Small (index 1 below)
  },

  // Hairstyles (painted in HAIR colour). Index 0 = Ponytail (Clobi default).
  hair: [
    { name: 'Ponytail', px: [
      [12, 2, 8, 1], [11, 3, 10, 1], [11, 4, 1, 2], [20, 4, 1, 2],
      [8, 5, 3, 1], [7, 6, 3, 4], [8, 10, 2, 1] /* tied tail behind */
    ] },
    { name: 'Short', px: [
      [12, 2, 8, 1], [11, 3, 10, 1], [11, 4, 1, 1], [20, 4, 1, 1]
    ] },
    { name: 'Long', px: [
      [12, 2, 8, 1], [11, 3, 10, 1], [10, 4, 2, 7], [20, 4, 2, 7]
    ] },
    { name: 'Spiky', px: [
      [12, 3, 8, 1], [11, 4, 10, 1],
      [12, 1, 1, 2], [15, 0, 1, 3], [18, 1, 1, 2], [20, 2, 1, 2]
    ] },
    { name: 'Bun', px: [
      [12, 2, 8, 1], [11, 3, 10, 1], [14, 0, 4, 2]
    ] },
    { name: 'Mohawk', px: [
      [15, 0, 2, 5], [14, 3, 4, 1]
    ] },
    { name: 'Afro', px: [
      [10, 1, 12, 4], [9, 2, 2, 3], [21, 2, 2, 3]
    ] },
    { name: 'Bald', px: [] }
  ],

  // Beards (painted in BEARD colour). Index 0 = None, 1 = Small (Clobi default).
  beard: [
    { name: 'None', px: [] },
    { name: 'Small', px: [
      [13, 10, 6, 1] /* moustache */, [12, 9, 1, 2], [19, 9, 1, 2],
      [12, 11, 9, 1] /* jaw */, [14, 12, 5, 1] /* chin */
    ] },
    { name: 'Full', px: [
      [11, 9, 2, 4], [19, 9, 2, 4], [12, 11, 8, 2], [13, 13, 6, 1], [13, 10, 6, 1]
    ] },
    { name: 'Goatee', px: [
      [13, 10, 6, 1], [14, 11, 4, 1], [15, 12, 2, 2]
    ] },
    { name: 'Moustache', px: [
      [13, 10, 6, 1]
    ] }
  ],

  // Hats — kind drives the geometry; c1/c2 are the chunky colours.
  hats: [
    { name: 'None', kind: 'none' },
    { name: 'Vim Cap', kind: 'cap', c1: '#1b7a3a', c2: '#0f4a24', logo: '#cfe9ff' },
    { name: 'Wizard', kind: 'wizard', c1: '#3a1d4a', c2: '#7ff9e0', star: '#fff27f' },
    { name: 'Crown', kind: 'crown', c1: '#ffcf3c', c2: '#ff9e2c', gem: '#ff5a3c' },
    { name: 'Beanie', kind: 'beanie', c1: '#ff5a3c', c2: '#fdfdfd' },
    { name: 'Tophat', kind: 'tophat', c1: '#11131c', c2: '#7ff9e0' },
    { name: 'Headphones', kind: 'phones', c1: '#2b2b2b', c2: '#ff9e2c' },
    { name: 'Halo', kind: 'halo', c1: '#fff27f', c2: '#ffcf3c' }
  ],

  // Eyes — kind drives the style.
  eyes: [
    { name: 'Classic', kind: 'classic' },
    { name: 'Angry', kind: 'angry' },
    { name: 'Sleepy', kind: 'sleepy' },
    { name: 'Shades', kind: 'shades' },
    { name: 'Sparkle', kind: 'sparkle' }
  ],

  // Accessories — drawn over the chest.
  accessories: [
    { name: 'None', kind: 'none' },
    { name: 'Bowtie', kind: 'bowtie', c1: '#ff5a3c' },
    { name: "Fisherman's", kind: 'fish', c1: '#7ff9e0', c2: '#11131c' },
    { name: 'Scarf', kind: 'scarf', c1: '#ff9e2c' },
    { name: 'Badge', kind: 'badge', c1: '#9cff5a' }
  ],

  // Capes — drawn behind the body.
  capes: [
    { name: 'None', kind: 'none' },
    { name: 'Hero', kind: 'cape', c1: '#ff5a3c', c2: '#b3331f' },
    { name: 'Mint', kind: 'cape', c1: '#7ff9e0', c2: '#3fb59c' },
    { name: 'Royal', kind: 'cape', c1: '#3a1d4a', c2: '#7a52a0' },
    { name: 'Gold', kind: 'cape', c1: '#ffcf3c', c2: '#b3870f' }
  ]
};

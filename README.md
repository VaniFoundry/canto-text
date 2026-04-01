# Canto Text

A Foundry VTT module that syncs lyric text to a playing song, displaying each line as screen-floating abno-text — inspired by the Canto fights in **Limbus Company**.

Built on top of [Abno Text](https://github.com/VaniFoundry/abno-text).

> Note: It doesn't allow to have presets stored right now, you will have to change it manually or have some macros pre-built if you wanna have various canto-songs in a session

## Features

- **Lyric Sync**: Displays each lyric line at a precise timestamp, triggered by a JSON sheet you configure
- **Audio Playback**: Plays a song from a URL or local Foundry path, synced to the lyric display
    > Note: Audio is optional — lyrics will still show on schedule without it
    
    > Note 2: It has some minor issues right now, might be fixed in future updates
- **Multiplayer Sync**: The GM's client drives playback, and all connected players receive each line via socket at the same time
- **Macro API**: Control playback and trigger one-off lines from macros

<!-- [Screenshot of lyric text displayed on screen during a Canto fight] -->

- **Typing & Visual Effects**: Inherits all of Abno Text's display options — typing speed, fade-out, font, color, angle, outline, shaky text and more
- **Controls Menu**: Play, Pause, Stop and Config all accessible through the scene controls panel (GM only)

<!-- [Screenshot showing the Canto Text controls in the scene toolbar] -->

## How It Works

The GM sets up a lyric sheet — a JSON list of lines, each with a timestamp in seconds — and optionally a song URL. When the GM hits Play, the audio starts and each lyric line is broadcast to all clients at the right moment, displayed on screen with Abno Text's typing effect and fade-out.

### Lyric Sheet Format

Open the **Config** panel from the scene toolbar and paste your lyric sheet in the **Lyric Sheet** field:

```json
[
  { "t": 0,    "text": "♪ Something something" },
  { "t": 4.5,  "text": "secoooond lineeee" },
  { "t": 9,    "text": "its almost over ♪" },
  { "t": 13.2, "text": "this song suuucks" }
]
```

`t` is the time **in seconds** from the start of the song when that line should appear. In the same panel, paste a URL or Foundry data path into **Song URL / Path**:
- `https://example.com/my-canto-theme.ogg`
- `data/music/limbus/canto-vi.ogg` *(relative to your Foundry data folder)*

### Controls

The module adds a control group to the scene toolbar (GM only):

| Button | Action |
|--------|--------|
| ⏻ Toggle | Enable / disable the module |
| ▶ Play / Pause | Start or pause the song + lyrics |
| ⏹ Stop | Stop and reset to the beginning |
| ⚙ Config | Open the configuration panel |

### Macro API

```js
// Play / pause / stop from a macro
game.cantoText.play();
game.cantoText.pause();
game.cantoText.stop();

// Show a one-off lyric instantly, without a song
game.cantoText.showLine("♪ I dont know if this would be used ♪");
```

> Note: For very tight sync, set `typingSpeed` low so lines appear almost instantly — `setTimeout` has a few ms of jitter that can add up

## Installation

1. Place the `canto-text/` folder inside your Foundry `Data/modules/` directory
2. Enable the module in Foundry's module management screen
3. Open the **Config** panel from the scene toolbar and set up your lyric sheet and song

## Compatibility

| Foundry Version | Status |
|---|---|
| v13 | ✅ Verified |
| v11 | ✅ Should be supported, didn't really check |
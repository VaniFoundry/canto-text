console.log("CANTO TEXT MODULE LOADED");

/* ============================================================
   CANTO TEXT — Lyric-synced abno-text for Foundry VTT v13

   Two audio modes:
     A) Playlist mode  — links to a PlaylistSound; reacts to
        Foundry's own play/pause/stop events automatically,
        including loops and manual restarts.
     B) URL mode       — manages its own <audio> element.

   In both modes the GM is the only one who schedules lyrics.
   Players receive each line via socket and display it locally.
============================================================ */

/* ------------------------------------------------------------------ */
/*  STATE                                                               */
/* ------------------------------------------------------------------ */
let activeRects   = [];   // bounding rects of visible text elements
let scheduledJobs = [];   // timeoutIds waiting to fire
let isPlaying     = false;
let pausedAt      = 0;    // URL-mode resume position (seconds)
let audioEl       = null; // URL-mode <audio> element

/* ------------------------------------------------------------------ */
/*  CONSTANTS                                                           */
/* ------------------------------------------------------------------ */
const DEFAULT_CONFIG = {
  lyrics: [
    { t: 0, text: "Your lyric here" },
    { t: 4, text: "Another line of lyrics" },
    { t: 8, text: "Keep adding as many as you need" }
  ],
  playlistSoundId:   "",
  songUrl:           "",
  fontSize:          30,
  color:             "#ff3333",
  fontFamily:        "serif",
  randomAngle:       true,
  maxAngle:          25,
  autoScaleLongText: true,
  maxSimultaneous:   4,
  outlineEnabled:    true,
  outlineColor:      "#000000",
  outlineThickness:  2,
  shakeyText:        false,
  shakeIntensity:    3
};

const TYPING_SPEED_MS = 40;
const FADE_OUT_MS     = 400;
const MIN_DISPLAY_MS  = 500;
const LAST_LINE_MS    = 3000;

/* ------------------------------------------------------------------ */
/*  INIT                                                                */
/* ------------------------------------------------------------------ */
Hooks.once("init", () => {

  game.settings.register("canto-text", "config", {
    scope: "world", config: false, type: Object, default: DEFAULT_CONFIG
  });
  game.settings.register("canto-text", "enabled", {
    scope: "world", config: false, type: Boolean, default: true
  });
  game.settings.registerMenu("canto-text", "configMenu", {
    name: "Canto-Text Configuration", label: "Open Configuration",
    type: CantoTextConfig, restricted: true
  });

  Handlebars.registerHelper("ct_eq", (a, b) => a === b);

  /* Players receive lyrics via socket */
  game.socket.on("module.canto-text", (data) => {
    if (data.type === "lyric") showAbnoMessage(data.text, data.displayMs);
    else if (data.type === "stop") stopAllText();
  });

  /* ------------------------------------------------------------------
     PLAYLIST SYNC — two complementary approaches:

     1) Hooks: try both "updatePlaylistSound" (v11/v12 style where
        args are (sound, change)) AND watching "updatePlaylist"
        (v13 style where the whole playlist doc is passed and sound
        updates are embedded in change.sounds).

     2) Polling: a 1-second interval that checks whether our tracked
        sound is playing and triggers scheduleFromTime if needed.
        This is the reliable fallback if hooks don't fire.
  ------------------------------------------------------------------ */

  // v11/v12 style — first arg is the PlaylistSound document directly
  Hooks.on("updatePlaylistSound", function() {
    var sound, change;
    // Foundry may pass (sound, change, ...) or (playlist, soundData, change, ...)
    // Detect by checking if first arg has a `parent` (PlaylistSound) or `sounds` (Playlist)
    if (arguments[0] && arguments[0].sounds) {
      // v13 style: (playlist, soundData, change, ...)
      var playlist  = arguments[0];
      var soundData = arguments[1];
      _handleSoundUpdate(playlist.id, soundData._id, soundData.playing, soundData.pausedTime);
    } else {
      // v11/v12 style: (sound, change, ...)
      sound  = arguments[0];
      change = arguments[1];
      if (sound && sound.parent) {
        var playing    = (change && "playing"    in change) ? change.playing    : sound.playing;
        var pausedTime = (change && "pausedTime" in change) ? change.pausedTime : sound.pausedTime;
        _handleSoundUpdate(sound.parent.id, sound.id, playing, pausedTime);
      }
    }
  });

  // v13 also fires updatePlaylist when a child sound changes
  Hooks.on("updatePlaylist", function(playlist, change) {
    if (!change || !change.sounds) return;
    var cfg = game.settings.get("canto-text", "config");
    if (!cfg.playlistSoundId) return;
    var parts = cfg.playlistSoundId.split("/");
    var plId  = parts[0];
    var sndId = parts[1];
    if (playlist.id !== plId) return;
    // change.sounds is an array of partial sound data objects
    var soundChange = change.sounds.find(function(s) { return s._id === sndId; });
    if (!soundChange) return;
    var liveSound = playlist.sounds.get(sndId);
    var playing    = ("playing"    in soundChange) ? soundChange.playing    : (liveSound ? liveSound.playing    : false);
    var pausedTime = ("pausedTime" in soundChange) ? soundChange.pausedTime : (liveSound ? liveSound.pausedTime : null);
    _handleSoundUpdate(plId, sndId, playing, pausedTime);
  });

  // Shared handler called by both hooks
  function _handleSoundUpdate(plId, sndId, playing, pausedTime) {
    if (!game.user.isGM) return;
    var cfg = game.settings.get("canto-text", "config");
    if (!cfg.playlistSoundId) return;
    var parts = cfg.playlistSoundId.split("/");
    if (plId !== parts[0] || sndId !== parts[1]) return;

    playing    = playing    ?? false;
    pausedTime = pausedTime ?? null;

    console.log("CANTO hook: playing=" + playing + " pausedTime=" + pausedTime + " isPlaying=" + isPlaying);

    if (playing) {
      var resumeFrom = pausedTime != null ? pausedTime : 0;
      setTimeout(function() { scheduleFromTime(resumeFrom); }, 150);
    } else {
      clearScheduled();
      isPlaying = false;
      if (pausedTime === null) {
        stopAllText();
        game.socket.emit("module.canto-text", { type: "stop" });
        console.log("CANTO: stopped, screen cleared");
      } else {
        console.log("CANTO: paused at " + pausedTime);
      }
    }
  }

  console.log("CANTO: init complete");
});

/* Polling fallback — 1s interval, starts on ready */
Hooks.once("ready", function() {
  setInterval(function() {
    if (!game.user.isGM) return;
    var cfg = game.settings.get("canto-text", "config");
    if (!cfg.playlistSoundId) return;

    var parts    = cfg.playlistSoundId.split("/");
    var playlist = game.playlists.get(parts[0]);
    var sound    = playlist ? playlist.sounds.get(parts[1]) : null;
    if (!sound) return;

    var nowPlaying = !!sound.playing;

    if (nowPlaying && !isPlaying) {
      console.log("CANTO poll: sound playing but not scheduled — triggering");
      var resumeFrom = sound.pausedTime != null ? sound.pausedTime : 0;
      scheduleFromTime(resumeFrom);
    } else if (!nowPlaying && isPlaying) {
      console.log("CANTO poll: sound stopped — clearing");
      clearScheduled();
      isPlaying = false;
      if (sound.pausedTime === null || sound.pausedTime === undefined) {
        stopAllText();
        game.socket.emit("module.canto-text", { type: "stop" });
      }
    }
  }, 1000);
});


/* ------------------------------------------------------------------ */
/*  SCENE CONTROLS                                                      */
/* ------------------------------------------------------------------ */
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;

  const isV11 = Array.isArray(controls);

  const toolToggle = {
    name: "toggle",
    title: game.settings.get("canto-text", "enabled") ? "Disable Canto-Text" : "Enable Canto-Text",
    icon: "fas fa-power-off", toggle: true,
    active: game.settings.get("canto-text", "enabled"),
    onClick: async () => {
      const next = !game.settings.get("canto-text", "enabled");
      await game.settings.set("canto-text", "enabled", next);
      if (!next) hardStop();
      ui.controls.render();
      ui.notifications.info("Canto-Text " + (next ? "Enabled" : "Disabled"));
    }
  };
  const toolPlay = {
    name: "play", title: "Play / Pause", icon: "fas fa-play", button: true,
    onClick: () => { if (isPlaying) pausePlayback(); else startPlayback(); }
  };
  const toolStop = {
    name: "stop", title: "Stop & Reset", icon: "fas fa-stop", button: true,
    onClick: () => hardStop()
  };
  const toolConfig = {
    name: "config", title: "Open Canto-Text Config", icon: "fas fa-music", button: true,
    onClick: () => new CantoTextConfig().render(true)
  };

  const group = {
    name: "cantoText", title: "Canto Text", icon: "fas fa-music",
    visible: true, layer: "controls", activeTool: "select",
    tools: isV11
      ? [{ name: "select", title: "Canto Text Controls", icon: "fas fa-music" },
         toolToggle, toolPlay, toolStop, toolConfig]
      : { select: { name: "select", title: "Canto Text Controls", icon: "fas fa-music" },
          toggle: toolToggle, play: toolPlay, stop: toolStop, config: toolConfig }
  };

  if (isV11) controls.push(group);
  else controls.cantoText = group;
});

/* ------------------------------------------------------------------ */
/*  PLAYBACK ENGINE                                                     */
/* ------------------------------------------------------------------ */

function scheduleFromTime(fromSeconds) {
  if (!game.settings.get("canto-text", "enabled")) return;

  const cfg    = game.settings.get("canto-text", "config");
  const lyrics = cfg.lyrics;
  if (!lyrics || !lyrics.length) return;

  clearScheduled();
  isPlaying = true;
  pausedAt  = fromSeconds;

  for (let i = 0; i < lyrics.length; i++) {
    const line  = lyrics[i];
    const delay = (line.t - fromSeconds) * 1000;
    if (delay < -200) continue;

    const nextT     = (lyrics[i + 1] ? lyrics[i + 1].t : line.t + LAST_LINE_MS / 1000);
    const gapMs     = (nextT - line.t) * 1000;
    const typingMs  = line.text.length * TYPING_SPEED_MS;
    const displayMs = Math.max(MIN_DISPLAY_MS, gapMs - typingMs - FADE_OUT_MS);

    (function(txt, dms) {
      const id = setTimeout(function() { broadcastAndShow(txt, dms); }, Math.max(0, delay));
      scheduledJobs.push({ id: id });
    })(line.text, displayMs);
  }

  console.log("CANTO: scheduled " + scheduledJobs.length + " lyric(s) from " + fromSeconds.toFixed(2) + "s");
}

function startPlayback() {
  if (!game.user.isGM) return;
  if (!game.settings.get("canto-text", "enabled")) return;

  const cfg = game.settings.get("canto-text", "config");
  if (!cfg.lyrics || !cfg.lyrics.length) {
    ui.notifications.warn("Canto-Text: No lyrics configured!");
    return;
  }

  if (cfg.playlistSoundId) {
    var parts    = cfg.playlistSoundId.split("/");
    var playlist = game.playlists.get(parts[0]);
    var sound    = playlist ? playlist.sounds.get(parts[1]) : null;
    if (!sound) {
      ui.notifications.error("Canto-Text: Linked sound not found — check config.");
      return;
    }
    if (sound.playing) {
      // Already playing — just re-sync lyrics
      setTimeout(function() {
        var t = sound.pausedTime != null ? sound.pausedTime : 0;
        console.log("CANTO: re-syncing to " + t.toFixed(2) + "s");
        scheduleFromTime(t);
        ui.notifications.info("Canto-Text: Lyrics re-synced!");
      }, 150);
    } else {
      playlist.playSound(sound);
      ui.notifications.info("Canto-Text: Playing via playlist!");
    }
    return;
  }

  // URL mode
  if (!audioEl) {
    if (cfg.songUrl) {
      audioEl = new Audio(cfg.songUrl);
      audioEl.addEventListener("ended", function() { isPlaying = false; pausedAt = 0; });
    } else {
      ui.notifications.warn("Canto-Text: No song configured. Showing lyrics only.");
    }
  }
  if (audioEl) {
    audioEl.currentTime = pausedAt;
    audioEl.play().catch(function(e) { ui.notifications.error("Canto-Text: Audio error — " + e.message); });
  }
  scheduleFromTime(pausedAt);
  ui.notifications.info("Canto-Text: Playing!");
}

function pausePlayback() {
  if (!isPlaying) return;

  const cfg = game.settings.get("canto-text", "config");

  if (cfg.playlistSoundId) {
    var parts    = cfg.playlistSoundId.split("/");
    var playlist = game.playlists.get(parts[0]);
    var sound    = playlist ? playlist.sounds.get(parts[1]) : null;
    if (sound && sound.playing) playlist.stopSound(sound);
    // hook fires → clears schedule + sets isPlaying=false
    return;
  }

  pausedAt = audioEl ? audioEl.currentTime : 0;
  if (audioEl) audioEl.pause();
  clearScheduled();
  isPlaying = false;
  ui.notifications.info("Canto-Text: Paused.");
}

function hardStop() {
  clearScheduled();
  isPlaying = false;
  pausedAt  = 0;

  const cfg = game.settings.get("canto-text", "config");

  if (cfg.playlistSoundId) {
    var parts    = cfg.playlistSoundId.split("/");
    var playlist = game.playlists.get(parts[0]);
    var sound    = playlist ? playlist.sounds.get(parts[1]) : null;
    if (sound && sound.playing) playlist.stopSound(sound);
  }

  if (audioEl) { audioEl.pause(); audioEl.currentTime = 0; audioEl = null; }

  stopAllText();
  if (game.user.isGM) game.socket.emit("module.canto-text", { type: "stop" });
  console.log("CANTO: hard stopped");
}

function clearScheduled() {
  scheduledJobs.forEach(function(j) { clearTimeout(j.id); });
  scheduledJobs = [];
}

function broadcastAndShow(text, displayMs) {
  showAbnoMessage(text, displayMs);
  game.socket.emit("module.canto-text", { type: "lyric", text: text, displayMs: displayMs });
}

/* ------------------------------------------------------------------ */
/*  DISPLAY ENGINE  (derived from abno-text by Vani)                   */
/* ------------------------------------------------------------------ */

function showAbnoMessage(text, displayMs) {
  if (!game.settings.get("canto-text", "enabled")) return;

  const cfg = game.settings.get("canto-text", "config");
  if (activeRects.length >= cfg.maxSimultaneous) return;

  const overlay     = $('<div class="canto-overlay"></div>');
  const textElement = $('<div class="canto-text"></div>');
  overlay.append(textElement);
  document.body.appendChild(overlay[0]);
  overlay.css({ opacity: 0 });

  textElement.css({
    position:   "absolute",
    fontSize:   cfg.fontSize + "px",
    color:      cfg.color,
    fontFamily: cfg.fontFamily,
    maxWidth:   "90vw",
    whiteSpace: "normal",
    textAlign:  "center",
    textShadow: cfg.outlineEnabled ? generateOutline(cfg) : "none"
  });

  textElement.text(text);
  if (cfg.autoScaleLongText) autoScaleText(textElement[0]);

  const rotDeg = cfg.randomAngle ? (Math.random() * cfg.maxAngle * 2) - cfg.maxAngle : 0;
  const placed = placeWithoutOverlap(textElement, rotDeg);
  if (!placed) { overlay.remove(); return; }

  activeRects.push(placed);
  textElement.css("transform", "rotate(" + rotDeg + "deg)");
  overlay.animate({ opacity: 1 }, 150);
  textElement.text("");

  let stopShake = null;
  if (cfg.shakeyText) stopShake = startShake(textElement[0], rotDeg, cfg.shakeIntensity);

  const lineDuration = (typeof displayMs === "number" && displayMs > 0) ? displayMs : LAST_LINE_MS;

  let i = 0;
  const typingInterval = setInterval(function() {
    textElement.text(text.slice(0, i++));
    if (i > text.length) {
      clearInterval(typingInterval);
      startLifetimeTimer(overlay, placed, lineDuration, stopShake);
    }
  }, TYPING_SPEED_MS);
}

function stopAllText() {
  document.querySelectorAll(".canto-overlay").forEach(function(el) { el.remove(); });
  activeRects = [];
}

function placeWithoutOverlap(element, rotDeg) {
  rotDeg = rotDeg || 0;
  element[0].offsetWidth;
  const rect  = element[0].getBoundingClientRect();
  const angle = rotDeg * Math.PI / 180;
  const rw    = Math.abs(rect.width  * Math.cos(angle)) + Math.abs(rect.height * Math.sin(angle));
  const rh    = Math.abs(rect.width  * Math.sin(angle)) + Math.abs(rect.height * Math.cos(angle));
  const maxX  = window.innerWidth  - rw;
  const maxY  = window.innerHeight - rh;
  if (maxX <= 0 || maxY <= 0) return null;

  for (let tries = 0; tries < 50; tries++) {
    const x = Math.random() * maxX;
    const y = Math.random() * maxY;
    element.css({ left: x + "px", top: y + "px", transform: "rotate(" + rotDeg + "deg)" });
    const nr = element[0].getBoundingClientRect();
    if (!activeRects.some(function(r) {
      return !(nr.right < r.left || nr.left > r.right || nr.bottom < r.top || nr.top > r.bottom);
    })) return nr;
  }
  return null;
}

function startLifetimeTimer(overlay, rect, displayMs, stopShake) {
  setTimeout(function() {
    if (stopShake) stopShake();
    overlay.fadeOut(FADE_OUT_MS, function() {
      activeRects = activeRects.filter(function(r) {
        return !(r.left === rect.left && r.top === rect.top &&
                 r.right === rect.right && r.bottom === rect.bottom);
      });
      overlay.remove();
    });
  }, displayMs);
}

function generateOutline(cfg) {
  const s = [];
  for (let x = -cfg.outlineThickness; x <= cfg.outlineThickness; x++)
    for (let y = -cfg.outlineThickness; y <= cfg.outlineThickness; y++)
      if (x !== 0 || y !== 0) s.push(x + "px " + y + "px 0 " + cfg.outlineColor);
  return s.join(",");
}

function autoScaleText(el) {
  let size = parseInt(window.getComputedStyle(el).fontSize);
  while ((el.scrollWidth > window.innerWidth * 0.95 ||
          el.scrollHeight > window.innerHeight * 0.95) && size > 12) {
    size -= 2;
    el.style.fontSize = size + "px";
  }
}

function startShake(el, rotDeg, intensity) {
  const t  = intensity / 10;
  const td = 2   + (t * t) * 60;
  const tr = 0.2 + (t * t) * 20;
  let rafId;
  function shake() {
    const dx = (Math.random() - 0.5) * td * 2;
    const dy = (Math.random() - 0.5) * td * 2;
    const dr = (Math.random() - 0.5) * tr * 2;
    el.style.transform = "rotate(" + (rotDeg + dr) + "deg) translate(" + dx + "px," + dy + "px)";
    rafId = requestAnimationFrame(shake);
  }
  rafId = requestAnimationFrame(shake);
  return function() { cancelAnimationFrame(rafId); el.style.transform = "rotate(" + rotDeg + "deg)"; };
}

/* ------------------------------------------------------------------ */
/*  CONFIG FORM                                                         */
/* ------------------------------------------------------------------ */
class CantoTextConfig extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "canto-text-config", title: "Canto-Text Configuration",
      template: "modules/canto-text/templates/settings.html",
      width: 700, height: "auto", closeOnSubmit: true,
      submitOnChange: false, resizable: true
    });
  }

  getData() {
    const cfg = game.settings.get("canto-text", "config");
    const playlistSounds = [];
    for (const pl of game.playlists)
      for (const snd of pl.sounds)
        playlistSounds.push({
          id:       pl.id + "/" + snd.id,
          label:    pl.name + " › " + snd.name,
          selected: cfg.playlistSoundId === (pl.id + "/" + snd.id)
        });
    return {
      ...cfg,
      lyricsJson:   JSON.stringify(cfg.lyrics, null, 2),
      playlistSounds,
      hasPlaylists: playlistSounds.length > 0
    };
  }

  async _updateObject(event, formData) {
    const data = foundry.utils.expandObject(formData);

    let lyrics = DEFAULT_CONFIG.lyrics;
    try {
      const parsed = JSON.parse(data.lyricsJson);
      if (!Array.isArray(parsed)) throw new Error("Must be a JSON array");
      lyrics = parsed
        .filter(function(l) { return typeof l.t === "number" && typeof l.text === "string"; })
        .sort(function(a, b) { return a.t - b.t; });
    } catch (e) {
      ui.notifications.error("Canto-Text: Bad lyrics JSON — " + e.message);
      return;
    }

    data.lyrics            = lyrics;
    data.randomAngle       = !!formData.randomAngle;
    data.autoScaleLongText = !!formData.autoScaleLongText;
    data.outlineEnabled    = !!formData.outlineEnabled;
    data.shakeyText        = !!formData.shakeyText;
    delete data.lyricsJson;

    if (audioEl) { audioEl.pause(); audioEl = null; }
    clearScheduled();
    isPlaying = false;

    await game.settings.set("canto-text", "config", data);
    ui.notifications.info("Canto-Text configuration saved!");
    console.log("CANTO: Config saved", data);
  }
}

/* ------------------------------------------------------------------ */
/*  MACRO API                                                           */
/* ------------------------------------------------------------------ */
Hooks.once("ready", () => {
  game.cantoText = {
    play:     startPlayback,
    pause:    pausePlayback,
    stop:     hardStop,
    showLine: function(text) { if (game.user.isGM) broadcastAndShow(text, LAST_LINE_MS); }
  };
  console.log("CANTO: game.cantoText API ready");
});

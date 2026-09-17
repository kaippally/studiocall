# OBS overlays: faces, chat and cards on your stream

This is the bit the whole project exists for. Three browser sources, all driven live from the desk.
No plugins, no hotkeys, no bobbleheads.

## 1. Adding them to OBS

In OBS: **Sources → + → Browser**, then paste a URL. The **OBS overlays** page in the desk lists
all three with copy buttons.

| Layer | URL | Suggested size |
|---|---|---|
| Speaking faces | `http://127.0.0.1:4019/studiocall/overlay.html?layer=speakers` | 760 × 300 |
| Room chat | `http://127.0.0.1:4019/studiocall/overlay.html?layer=chat` | 460 × 660 |
| Profile card | `http://127.0.0.1:4019/studiocall/overlay.html?layer=card` | 720 × 340 |

The layer fills the browser source, so size the source, not the page. The background is
transparent.

> 💡 The overlays connect to the server themselves, so they keep working with the desk closed. If
> you restart OBS or the server, they reconnect on their own.

## 2. Speaking faces (`layer=speakers`)

Whoever is talking appears as a face standing on the bottom edge of the box, with a name plate, and
leaves when they stop. Several talking at once line up side by side and shrink to fit.

How it knows *who* is talking: the audio engine is in the room, and Agora reports the volume
**per person**. That's the trick an OBS audio plugin can't do, because by the time audio reaches
OBS it's one mixed track.

- **Your own face never appears.** You're presumably already on camera. Two of you would be a lot.
- **Reactions** float up over the face they were aimed at.
- **Speaker bounce** (Room page → Controls): off, faces just appear and disappear without moving.

## 3. Room chat (`layer=chat`)

Driven by the **Chat** page: roll all lines, or show only the line you held. Entrance and exit
animations are picked there too. **Room chat on air** (Room page → Controls) switches the layer on
and off.

## 4. Profile card (`layer=card`)

Put up from a profile card (click the picture). It shows the photo, name strip, bio, follower counts
and what the people log knows ("listener since…"). A profile with no bio and no counts is shown as
a big photo instead of a sad empty card, and a profile with no photo *either* isn't put up at all.
It comes down when you click again, close the card, or leave the room.

## 5. Styling with URL parameters

Every parameter after `layer` is a style. Numbers and `true`/`false` are read as such. URL-encode
`#` as `%23`.

```
overlay.html?layer=speakers&color=%23f59e0b&speakerAnim=blink&titleSize=28
```

### 5.1 Speaking faces

| Parameter | Default | What |
|---|---|---|
| `color` | `#38bdf8` | Ring / accent colour |
| `fontFamily` | system | Name plate font. It must be a font the **OBS browser** can load; OBS doesn't see your installed fonts reliably. |
| `titleSize` | auto | Name size in px |
| `opacity` | `1` | Whole layer |
| `speakerAnim` | `bounce` | `bounce` (a gentle waft) or `blink` (fade up from dark, no movement) |
| `speakerSensitivity` | `50` | 1–100: how loud before a face counts as talking |
| `speakerImageSize` | `0` | Face size in px; `0` fits the faces to the box |
| `bounceHeight` | `18` | Drift height, % of the face |
| `waftMs` | `2000` | One drift cycle, ms (300–6000) |
| `bounceEase` | ease | CSS easing for the drift |
| `plateBg` | `#0a0c12` | Name plate background |
| `plateOpacity` | `82` | Name plate opacity, % |
| `plateShadow` | `0` | Name plate shadow |
| `plateWidth` | `160` | Max plate width, % of the face |
| `plateWrap` | `false` | Wrap long names instead of cutting them off |
| `borderWidth` / `borderColor` / `borderOpacity` / `borderRadius` | none | Name plate border |

### 5.2 Room chat

| Parameter | What |
|---|---|
| `color` | Accent |
| `fontFamily` / `bodyFontFamily` | Name / message fonts |
| `bodySize` | Message size, px |
| `photoScale` / `photoRadius` / `photoBorder` | Avatar size, corner, ring |
| `duration` | Seconds a line stays up (0 = until replaced) |
| `opacity` | Whole layer |

### 5.3 Profile card

| Parameter | What |
|---|---|
| `color`, `borderColor` | Accents |
| `fontFamily`, `bodyFontFamily`, `titleSize`, `bodySize` | Type |
| `photoScale`, `nameScale` | Photo band and name strip, % of the card height |
| `photoRadius`, `photoBorder`, `cardMargin`, `nameMargin`, `cardScale` | Shape |
| `reflection`, `reflectionOpacity`, `reflectionDistance`, `reflectionFeather`, `reflectionBlur` | A glossy floor reflection, for the dramatic |
| `threedRotX`, `threedRotY`, `threedFov` | Tilt the card in 3D |
| `showAnimation`, `hideAnimation`, `animInMs` | Entrance and exit |

## 6. Nothing is showing: checklist

1. Is the server up? Open `http://127.0.0.1:4019/api/studiocall/health` in a browser.
2. **Faces:** are you in a room, is the engine joined (Audio page), and is someone *other than you*
   talking?
3. **Chat:** is **Room chat on air** on? In *selected* mode, have you held a line?
4. **Card:** did you click the *picture* on a profile card?
5. Right-click the source in OBS → **Interact**, or **Refresh cache of current page**.

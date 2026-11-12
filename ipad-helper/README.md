# Calenduel iPad

A small menu-bar app for macOS 13+ that puts your iPad in the session timelapse
with no setup per session: plug the iPad in by USB and start a session.

It reads the iPad's screen the way QuickTime's *New Movie Recording → iPad*
does (CoreMediaIO screen-capture devices) and serves the newest frame on
`http://127.0.0.1:47615`. Chrome can't open the iPad itself: macOS only shows
iPad screens to a process that asks for them.

## Install

Needs the Xcode command-line tools (`xcode-select --install`).

```sh
./ipad-helper/build.sh --install
```

This builds `Calenduel iPad.app` (ad-hoc signed, for your own Mac), copies it to
`~/Applications` and opens it. On first launch it:

1. adds itself as a login item (toggle it in the menu), and
2. opens `calenduel.com/?ipadHelper=1`, which turns the helper on for that browser.

macOS may ask for camera access the first time it reads the iPad, and Chrome asks
once whether calenduel.com may access apps on this device. Allow both.

## Use

Unlock the iPad, connect it by USB and tap **Trust** the first time. Start a
session: the iPad shows up under your face within a few seconds. **Remove iPad**
takes it out for the rest of the session; **Add iPad** brings it back. Without
the helper, **Add iPad** still offers the window picker (QuickTime mirroring).

The menu-bar icon is grey with no iPad, normal when one is connected, and red
while it is sending frames to a session.

## Privacy

- Listens on 127.0.0.1 only and answers only calenduel.com (and the local dev
  server). Other sites, `<img>` tags and requests without an Origin get 403.
- Captures only while a page is asking for frames; stops after 10 s without one.
- Keeps nothing on disk. Frames stay in memory until the next one replaces them.
- To turn it off in a browser, open `calenduel.com/?ipadHelper=0`.

## Endpoints

- `GET /status`: `{"app":"calenduel-ipad","version":1,"connected":bool,"capturing":bool}`
- `GET /frame`: newest frame as JPEG (long side at most 1600 px). 204 while
  connected with no picture yet, 404 with no iPad.

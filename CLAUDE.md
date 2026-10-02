# CLAUDE.md

## Git

**Committing is the user's call, not the agent's.** Leave finished work in the
working tree and say what changed. Do not run `git commit` (or `git push`) unless
the user asks for it in that message.

## What this project is

A purely visual, click-through overlay for Slay the Spire 2 on macOS: it
screenshots the game, OCRs the names on screen, and badges each card and relic
with its tier rating from Baalorlord's tier lists on sts2.untapped.gg. See
[README.md](README.md) for architecture, the data source and the config table.

## Working on it

- The app is Electron. `npm start` runs it; `npm run dump` saves the scraped
  pages to `debug/` when the untapped.gg extraction needs re-tuning.
- Electron may fail to initialise in a sandboxed/headless shell
  (`Cannot read properties of undefined (reading 'whenReady')`). That is the
  environment, not the code — verify data-layer changes by requiring
  `src/cards.js` directly from plain `node` instead.
- Screen-layout changes (badge placement, which screens are recognised) can't be
  verified without the running game. Ask the user for a screenshot rather than
  guessing at coordinates.

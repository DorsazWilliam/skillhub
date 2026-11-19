# Mobile (iPhone, installed PWA)

Principles for the phone layout of SkillHub (viewport under 768 px). Tablet and desktop keep the rail, tree and drawer. iOS conventions win over Material ones: people install the hub to the home screen and expect it to behave like a native iPhone app.

Sources are listed per section. The Apple HIG pages were looked up by search during research; developer.apple.com could not be fetched from the research machine, so check the live pages before treating a detail as final.

## 1. Structure and navigation

- **Tab bar for top-level sections only.** Up to 5 tabs on iPhone; ours are Library, Search, Graph, Account. Tabs navigate, they never perform actions. Icons with no visible label are acceptable only because each tab has an `aria-label`; keep the set small and the icons unambiguous.
- **Each tab keeps its own stack.** Switching tabs restores where the person was. Tapping the active tab pops it to its root (the standard UIKit behavior).
- **Hierarchy is a push stack, not a tree.** Area, folder, page. Each level is a full screen with a back button (chevron only, labelled for assistive tech) on the leading side of the navigation bar.
- **Large title that collapses.** The first screen of each level shows a large title in the content. On scroll it collapses into a compact centered title in the bar; the bar gets its hairline and material only once content scrolls under it.
- **At most two or three bar items.** Primary action trailing (edit, new); the rest goes into a single "more" menu.
- **Swipe from the leading edge goes back.** Standalone mode has no browser chrome and no back button, so every pushed screen must offer an on-screen back and the edge swipe. Keep the history stack in app state; do not rely on `history.back()` alone.
- **Hide the tab bar while composing.** The editor is a focused task: the tab bar steps away, the keyboard accessory toolbar takes its place.

Sources: https://developer.apple.com/design/human-interface-guidelines/tab-bars , https://developer.apple.com/design/human-interface-guidelines/navigation-bars , https://developer.apple.com/design/human-interface-guidelines/toolbars , https://developer.apple.com/videos/play/wwdc2017/810/

## 2. Lists

- **Inset grouped lists** for folders, files and settings: rounded groups on a grouped background, rows of at least 44 pt, leading icon, title, optional secondary line, trailing status and a disclosure chevron when the row pushes a screen.
- **Swipe actions** reveal trailing actions (Share, Move, Delete). Destructive action is last and red. Swipe actions are shortcuts: every action must also be reachable another way (context menu or the screen's more menu).
- **Long press opens a context menu** with the same actions. Never hide an action behind long press only.
- **Tap anywhere on an open swiped row closes it** instead of navigating.

Sources: https://developer.apple.com/design/human-interface-guidelines/lists-and-tables , https://developer.apple.com/design/human-interface-guidelines/context-menus

## 3. Sheets instead of modals

- **No centered modals on iPhone.** Details, share, publish, commit, version pickers and menus are bottom sheets.
- **Two detents:** medium (about half height) and large (full height minus the top inset). A resizable sheet shows a **grabber**; dragging it resizes, tapping it cycles detents, dragging down past medium dismisses.
- **Short menus are action sheets** that size to their content.
- Sheets always keep an explicit close or done control, for people who do not drag.

Sources: https://developer.apple.com/design/human-interface-guidelines/sheets , https://developer.apple.com/videos/play/wwdc2021/10063/

## 4. Touch, feedback, motion

- **44 x 44 pt minimum hit area.** Icons can be 20 to 24 pt; the button around them is 44.
- **No hover-only affordances.** Anything revealed on hover on desktop (row actions, tooltips, graph labels) needs a visible or tap-based equivalent. Tooltips are suppressed for touch.
- **Subtle press state** (background tint or slight scale) instead of the grey tap flash: `-webkit-tap-highlight-color: transparent` plus `:active` styles.
- **Haptics analogue:** the web has no Taptic Engine on iOS (`navigator.vibrate` is unsupported in Safari), so confirm with motion and a short state change instead; call `vibrate` only as a progressive enhancement.
- **Motion is short and physical:** push slides from the trailing edge, pop from the leading edge, sheets rise from the bottom. All of it is disabled under `prefers-reduced-motion: reduce`.
- **Gestures in canvases:** the graph takes pinch to zoom and one-finger pan (`touch-action: none` on the canvas only). Tap selects a node and shows a small card with an open action; hover does nothing.

Sources: https://developer.apple.com/design/human-interface-guidelines/accessibility , https://developer.apple.com/design/human-interface-guidelines/buttons , https://frontendchecklist.io/rules/accessibility/touch-targets

## 5. Type and iconography

- **System font on iPhone:** `-apple-system, BlinkMacSystemFont, system-ui`. It gives SF Pro with correct optical sizes.
- **Text sizes follow the iOS text styles:** large title 34 bold, title 17 semibold in bars, body 17, secondary 15, footnote 13. Use `rem`/relative units so text scales with the user's setting; layouts reflow, they do not truncate essential text.
- **Icons in the SF Symbols spirit:** one consistent stroke family (Lucide here), sized with the text, no emoji.

Sources: https://developer.apple.com/design/human-interface-guidelines/typography , https://developer.apple.com/design/human-interface-guidelines/sf-symbols

## 6. Search

- Full screen, field at the top, a cancel control that clears the query and dismisses the keyboard, a clear control inside the field.
- Show **recent items** when the field is empty; results grouped and tappable as list rows.

Source: https://developer.apple.com/design/human-interface-guidelines/search-fields

## 7. PWA specifics on iOS Safari

- **Meta tags:** `viewport` with `width=device-width, initial-scale=1, viewport-fit=cover`; `apple-mobile-web-app-capable` (and `mobile-web-app-capable`); `apple-mobile-web-app-title`; `apple-mobile-web-app-status-bar-style` (`default` keeps dark text readable on the light theme; `black-translucent` needs content painted under the status bar); `theme-color` per color scheme; an `apple-touch-icon` (180 x 180). A real deployment also ships a `manifest.webmanifest` with `"display": "standalone"`, `name`, `start_url`, `icons`.
- **Safe areas:** with `viewport-fit=cover`, pad bars with `env(safe-area-inset-top|bottom|left|right)`. The tab bar sits on top of the bottom inset; the navigation bar below the top inset.
- **Height:** use `100dvh` (fallback `100vh`) for the app shell; the body itself does not scroll, each screen has its own scroll container with `overscroll-behavior: contain` so rubber-banding stays inside it.
- **Inputs at 16 px or larger** or Safari zooms on focus. Do not disable user zoom to avoid it.
- **Keyboard:** iOS shrinks the visual viewport, not the layout viewport. Dock the editor toolbar above the keyboard by reading `visualViewport.height` and `offsetTop` on its `resize` and `scroll` events. Safari has no VirtualKeyboard API.
- **Momentum scrolling** is the default on modern iOS; keep scroll containers `overflow: auto` and avoid nested scrollers in the same axis.
- **Standalone back navigation:** no browser back button. Every pushed screen has a back control and the edge swipe; deep states (sheets) close with drag down or a close control.
- **Detect standalone** with `@media (display-mode: standalone)` or `navigator.standalone` when a behavior must differ.

Sources: https://webkit.org/blog/7929/designing-websites-for-iphone-x/ , https://developer.mozilla.org/en-US/docs/Web/CSS/env , https://developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API , https://bugs.webkit.org/show_bug.cgi?id=254868 , https://blog.openreplay.com/5-mobile-web-papercuts-fixes/ , https://developer.chrome.com/blog/overscroll-behavior , https://web.dev/learn/pwa/app-design

## 8. Applied in the prototype

| Principle | Where |
|---|---|
| Tab bar, four tabs, state kept per tab, tap active tab to pop to root | `m-tabs` |
| Push stack with large collapsing title, icon back, leading-edge swipe back | `m-nav`, `m-large`, edge swipe handler |
| Inset grouped lists, chevrons, swipe actions, long-press menu | `m-group`, `m-row` |
| Sheets with medium and large detents, grabber, drag to dismiss | modals, menus and details on phone |
| Editor toolbar docked above the keyboard, 16 px inputs, tab bar hidden | `--kb` from `visualViewport` |
| Graph full screen, pinch and pan, tap to select with a card | `gcard` |
| Full-screen search with cancel and recent items | Search tab |
| Safe areas, `100dvh`, reduced motion, no hover reliance | CSS under `max-width: 767px` |

# JEV Weekend Shopping · Chrome Extension

[简体中文](README.md) | **English**

### Bring your support for two-day weekends into every shopping trip.

Browse Taobao and JD as usual. JEV uses product, shop, and brand text to guess the working schedule behind a product. **If it predicts fewer than two days off per week, a PASS stamp appears on the product image.** Here, PASS means “skip this item.”

No copying product descriptions. No switching to a chat window. No local model downloads.

**[Download extension ZIP ↓](https://github.com/littlewindy123/jev-weekend-shopping-chrome/archive/refs/heads/main.zip)** · [Get a JEV API key](https://console.typesafe.ai/keys) · [Report an issue](https://github.com/littlewindy123/jev-weekend-shopping-chrome/issues)

Chrome 137+ · v0.4.5 · MIT licensed · Requires your own TypeSafe API key

## See it in action

### Taobao: browse, scroll, and see the stamps

![Live Taobao screenshot showing PASS stamps on some product images while other products remain unchanged](docs/taobao-live.png)

**The results appear right on Taobao.** This user-provided screenshot of v0.4.4 shows 12 classified products: 10 stamped and 2 left unchanged.

### JD: the same store, with an extra cue

![Live JD screenshot with a PASS stamp on the left product and neighboring products unchanged](docs/jd-live.png)

**One product gets a stamp; its neighbors stay as they are.** The overlay sits on the original image and does not block product clicks.

*These live-page screenshots show earlier versions. From v0.4.5, product images display only PASS; the explanatory note remains in the popup and disclaimer. A stamp is an AI guess, not evidence of a merchant’s actual employment practices.*

- **Classify as you scroll.** Newly visible products are picked up automatically.
- **Use the clues available.** Shop and brand information comes first; product text is used when those clues are missing.
- **Two outcomes.** A predicted shorter weekend gets a PASS stamp; a predicted two-day weekend leaves the product unchanged.
- **Pause whenever you want.** Turn the extension off to remove the stamps.

## Get started in four steps

### 1. Download and extract

[Download the complete ZIP](https://github.com/littlewindy123/jev-weekend-shopping-chrome/archive/refs/heads/main.zip), or choose **Code → Download ZIP** on the repository page.

<img src="docs/download.png" width="430" alt="GitHub Code menu with Download ZIP at the bottom">

Extract the ZIP to a permanent folder. Open that folder and locate **`manifest.json`**. Keep the folder in place after installation: Chrome reads the extension from it.

### 2. Load it in Chrome

1. Open `chrome://extensions` in the address bar.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Look for **双休购物** in the extension list.

You do not need Node.js, npm, or a build step. This is a complete unpacked extension; it is not currently listed in the Chrome Web Store.

### 3. Add your key and enable the extension

Click Chrome’s puzzle icon, then **双休购物**. The extension interface is currently in Chinese; this guide translates the controls.

<img src="docs/popup.png" width="360" alt="Initial extension popup: enable switch at the top, TypeSafe API key field in the middle, save and test button below">

1. Paste your own [TypeSafe API key](https://console.typesafe.ai/keys) into **TypeSafe 官方 API Key**.
2. Click **保存并测试连接** (“Save and test connection”).
3. After **官方 JEV 连接成功** (“Official JEV connected successfully”), turn on the top switch. **已开启** means enabled; **已暂停** means paused.

The screenshot shows the unconfigured v0.4.3 popup; the steps are unchanged in v0.4.5. Connection testing sends a fictional sample request to the API.

### 4. Refresh the store and start browsing

Open the recommendation feed on [JD](https://www.jd.com/) or [Taobao](https://www.taobao.com/), or a supported product list. **Refresh any store tab that was already open before installation.** Close the popup and scroll normally.

The bottom-left status shows detected, classified, stamped, and unstamped counts. Request errors are reported separately and are not treated as a classification result.

## Quick help

| What you see | What to do |
| --- | --- |
| Connected, but nothing happens | Enable the top switch, refresh the store page, and scroll to product cards. |
| Classifications increase, but there are no stamps | Those products may have been predicted to offer two days off. Only the other outcome gets a stamp. |
| **当前页未连接** (“Current page not connected”) | Refresh a supported store page and reopen the popup. |
| Key, network, rate-limit, or quota error | Check the error shown in the popup and your TypeSafe account. |
| An update is available | Replace the files in the original installation folder, click **Reload** in Chrome’s extension manager, and refresh store tabs. Keep the existing extension to retain settings. |

## Disclaimer

- **AI guesses, for reference only.** Product listings cannot establish employee schedules. Neither a stamp nor its absence certifies a merchant’s working conditions.
- **Free extension, your own API usage.** The code is free and open source. API calls consume your TypeSafe quota under its current account and pricing rules.
- **Data and privacy.** Product text needed for classification is sent to TypeSafe. The extension does not collect cookies, orders, or chats. Your key is stored locally in extension storage and sent only to the official API.
- **Coverage.** Adapters cover JD home/search/list pages and Taobao home/search pages. Live homepage stamps have been observed on JD and confirmed by the user on Taobao. Not every campaign or product-detail page is supported, and store redesigns may affect compatibility.

## Join in

If this idea resonates with you, **star the repository** or share it with someone who cares about two-day weekends.

[Issues](https://github.com/littlewindy123/jev-weekend-shopping-chrome/issues) · [Development notes (中文)](docs/DEVELOPMENT.md) · [Test records (中文)](docs/TESTING.md) · [MIT license](LICENSE)

An independent community project, not affiliated with TypeSafe, JD, or Taobao. See [third-party notes](THIRD_PARTY.md).

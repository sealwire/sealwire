# Connect from your phone or another computer

[中文](remote-access.zh-CN.md)

Sealwire runs on the computer that has your projects, and only that computer can
open it directly. To use it from your phone, or from a laptop somewhere else, you
connect through SealWire Cloud. On the other device there is nothing to install:
with Cloud, Sealwire opens in the browser at <https://app.sealwire.dev>.
Everything sent between your devices is end-to-end encrypted, so the Cloud
server passes messages along without being able to read them.

This guide is for SealWire Cloud. If you run your own connection server, see
[the last section](#your-own-server-instead-of-sealwire-cloud).

The computer has to stay on, with Sealwire running, for as long as you want to
reach it.

## What you need

- Sealwire installed on your computer (see the [README](../README.md)).
- A SealWire Cloud access key. SealWire Cloud is in beta; to get a key, email
  [sealwire.dev@gmail.com](mailto:sealwire.dev@gmail.com).
- A phone or computer with a current browser.

## 1. Start Sealwire with Cloud turned on

```bash
npx sealwire cloud
```

The first time, it asks for your access key; what you type stays hidden. After
that it remembers it, so later runs of `npx sealwire cloud` start straight away.

Plain `npx sealwire` does not connect to Cloud, so paired devices cannot reach it.
Use `npx sealwire cloud` whenever you want to get in from elsewhere.

On a computer with no screen to type into, such as a home server, set
`SEALWIRE_CLOUD_ACCESS_KEY` (or `SEALWIRE_CLOUD_ACCESS_KEY_FILE`, a path to a
file holding the key) for the first run instead.

## 2. Show the pairing QR code

In Sealwire on your computer:

1. Click the gear icon at the bottom of the sidebar to open **Settings**.
2. Open **Devices**.
3. Click **Pair new device**.

A QR code appears. Before scanning, you can choose what the new device may open
under **This device can open**: every folder Sealwire is allowed to use, or just
one folder.

The code lasts 3 minutes and works only once. If it runs out, click **new code**.

## 3. Scan it with your phone

Point your phone's camera at the QR code and open the link it offers; it opens
app.sealwire.dev. The page shows a **fingerprint**, a short code that identifies
your phone, and waits for your computer to say yes.

To pair another computer instead, use **Or send the link** under the QR code.
Copy the link and open it in that computer's browser, or open
app.sealwire.dev there and paste the link into the box it shows.

## 4. Approve it on your computer

The request appears in **Settings › Devices**, under **Waiting for approval**.
Check that the fingerprint there matches the one on your phone, then click
**Approve**. If they differ, or you don't recognise the request, click
**Reject**.

That's it. Your sessions now show up on your phone, and from there you can send
messages, answer approvals, and stop a running agent.

Next time, just open <https://app.sealwire.dev> in the same browser. The pairing
is saved in that browser only: a different browser, even on the same phone, has
to be paired again.

## 5. Add it to your home screen

So app.sealwire.dev opens like an app:

- **iPhone / iPad:** in Safari, tap Share, then **Add to Home Screen**. Only
  Safari can do this on iOS.
- **Android:** in Chrome, open the menu and choose **Add to Home screen** or
  **Install app**.

Notifications turn on by themselves once the device is paired; your browser may
ask for permission first. On iPhone they need iOS 16.4 or later, and only work
from the home-screen app, not from a Safari tab.

## Removing a device

In **Settings › Devices**, find the device and click **Revoke**. It is cut off at
once. **Revoke all others** keeps the one you pick and removes every other
device.

To disconnect this computer from SealWire Cloud entirely:

```bash
npx sealwire cloud unbind
```

The next `npx sealwire cloud` will ask for an access key again.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| "This QR code or pairing link has expired" | Click **new code** on your computer and scan again. |
| "Another device took over this pairing code" | A second device scanned the same code. Make a new code and scan it on one device only. |
| The phone keeps saying it is waiting to reconnect | The computer is asleep, or Sealwire was started without `cloud`. Wake it, or restart with `npx sealwire cloud`. |
| No notifications on iPhone | Add Sealwire to the home screen and open it from there; check you are on iOS 16.4 or later. |
| The phone asks you to pair again | Its saved login was cleared or ran out. Pair it again from step 2. |

## Your own server instead of SealWire Cloud

You can run the connection server yourself. Setting it up, and the command that
starts Sealwire against it in place of `npx sealwire cloud`, are in
[DEPLOYMENT.md](../DEPLOYMENT.md#use-your-own-broker); no access key is needed.
After that, steps 2 to 5 are the same, except that everywhere this guide says
app.sealwire.dev, your devices open your server's address instead.

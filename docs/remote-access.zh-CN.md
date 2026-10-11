# 用手机或另一台电脑连进来

[English](remote-access.md)

Sealwire 跑在放着你项目的那台电脑上，默认只有这台电脑自己能打开它。想在手机上、或者在别处的笔记本上用，要通过 SealWire Cloud 连进来。另一台设备上什么都不用装，用 Cloud 的话，在浏览器里打开 <https://app.sealwire.dev> 就是 Sealwire。设备之间传的所有内容都是端到端加密的，Cloud 的服务器只负责转发，读不到内容。

这份说明讲的是 SealWire Cloud。如果你用自己搭的连接服务器，看[最后一节](#不用-sealwire-cloud用自己的服务器)。

想从外面连进来的这段时间里，这台电脑要一直开着，Sealwire 也要一直在跑。

## 需要准备

- 电脑上装好 Sealwire（见 [README](../README.zh-CN.md)）。
- 一把 SealWire Cloud access key。SealWire Cloud 目前在 beta 测试，需要的话发邮件到 [sealwire.dev@gmail.com](mailto:sealwire.dev@gmail.com) 申请。
- 一部手机，或另一台电脑，装着较新的浏览器。

## 1. 用 Cloud 模式启动 Sealwire

```bash
npx sealwire cloud
```

第一次运行会要你输入 access key，输入时屏幕上不显示。之后它会记住，再运行 `npx sealwire cloud` 就直接启动了。

直接运行 `npx sealwire` 不会连 Cloud，已经配对的设备也连不进来。想从外面用的时候，记得用 `npx sealwire cloud` 启动。

如果是没有屏幕可以输入的电脑（比如家里的服务器），第一次运行时改用环境变量 `SEALWIRE_CLOUD_ACCESS_KEY` 传 key，或者用 `SEALWIRE_CLOUD_ACCESS_KEY_FILE` 指向一个存着 key 的文件。

## 2. 在电脑上打开配对二维码

在电脑上的 Sealwire 页面里：

1. 点侧边栏最下面的齿轮图标，打开 **Settings**。
2. 点 **Devices**。
3. 点 **Pair new device**。

页面上会出现一个二维码。扫码之前，可以在 **This device can open** 下面选这台新设备能打开什么：Sealwire 允许使用的所有文件夹，或者只有某一个文件夹。

二维码 3 分钟内有效，只能用一次。过期了就点 **new code** 重新生成。

## 3. 用手机扫码

用手机相机对准二维码，打开它弹出的链接，会打开 app.sealwire.dev。页面上会显示一串 **fingerprint**（用来认出这部手机的一小段字符），然后等电脑那边同意。

如果要连的是另一台电脑而不是手机，用二维码下面的 **Or send the link**：复制链接，在那台电脑的浏览器里打开；或者在那台电脑上打开 app.sealwire.dev，把链接粘贴到页面上的输入框里。

## 4. 回到电脑上点同意

请求会出现在 **Settings › Devices** 的 **Waiting for approval** 下面。核对这里的 fingerprint 和手机上显示的一样，然后点 **Approve**。如果对不上，或者你不认识这个请求，点 **Reject**。

这样就连好了。你的会话会出现在手机上，可以在手机上发消息、回应智能体的批准请求、停掉正在跑的智能体。

以后在同一个浏览器里直接打开 <https://app.sealwire.dev> 就行。配对信息只存在这个浏览器里：换一个浏览器，哪怕是同一部手机，也要重新配对。

## 5. 加到手机主屏幕

把 app.sealwire.dev 加到主屏幕后，打开就像一个 App：

- **iPhone / iPad：** 在 Safari 里点分享按钮，再点 **添加到主屏幕**。iOS 上只有 Safari 能做这一步。
- **Android：** 在 Chrome 里打开菜单，选 **添加到主屏幕** 或 **安装应用**。

配对完成后通知会自动打开，浏览器可能会先问你要不要允许。iPhone 上收通知需要 iOS 16.4 或更新版本，而且只有从主屏幕图标打开才行，在 Safari 标签页里不行。

## 删掉一台设备

在 **Settings › Devices** 里找到那台设备，点 **Revoke**，它马上就连不进来了。点 **Revoke all others** 会只留下你选的那台，其他设备全部删掉。

想让这台电脑彻底不再连 SealWire Cloud：

```bash
npx sealwire cloud unbind
```

之后再运行 `npx sealwire cloud` 会重新要 access key。

## 遇到问题

| 看到的情况 | 怎么办 |
| --- | --- |
| "This QR code or pairing link has expired" | 在电脑上点 **new code**，重新扫。 |
| "Another device took over this pairing code" | 有第二台设备扫了同一个二维码。重新生成一个，只用一台设备扫。 |
| 手机一直显示在等待重新连接 | 电脑睡着了，或者 Sealwire 启动时没加 `cloud`。把电脑唤醒，或者用 `npx sealwire cloud` 重新启动。 |
| iPhone 收不到通知 | 把 Sealwire 加到主屏幕，从主屏幕图标打开；确认系统是 iOS 16.4 或更新。 |
| 手机要你重新配对 | 手机上保存的登录信息被清掉了或过期了。从第 2 步重新配对。 |

## 不用 SealWire Cloud，用自己的服务器

连接服务器也可以自己搭。服务器怎么搭、以及用什么命令代替 `npx sealwire cloud` 让 Sealwire 连到它，见 [DEPLOYMENT.md](../DEPLOYMENT.md#use-your-own-broker)，不需要 access key。之后第 2 到第 5 步一样，只是上面所有写 app.sealwire.dev 的地方，设备上打开的都换成你自己服务器的地址。

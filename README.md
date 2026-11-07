# PULSE · 节奏游乐场

三种键盘与触屏音游、六首原创 Web Audio 合成音乐、三档难度，共 54 张确定性谱面。原生 HTML、CSS、ES modules 和 Canvas，无构建步骤、无服务端、无账号要求。

[在线游玩](https://lin-yang-gameverse-2026.yanglinchasel.chatgpt.site/games/pulse/) · [Linverse](https://lin-yang-gameverse-2026.yanglinchasel.chatgpt.site/)

## 本地运行

需要 Python 3；测试与语法检查需要 Node.js 22 或更新版本。无需 npm install。

```sh
git clone https://github.com/LinYangBIT/pulse-arcade.git
cd pulse-arcade
npm start
# 打开 http://127.0.0.1:4175/
npm test
npm run check
```

没有 Node 时可直接运行 `python3 -m http.server 4175 --bind 127.0.0.1 --directory dist`。请通过 HTTP 打开，ES modules 不支持直接双击 HTML 的 file:// 方式。

## 玩法

| 模式 | 操作 |
| --- | --- |
| 4K FLOW 四键下落 | 音符抵达判定线时按 D / F / J / K，或点击对应轨道／触控键 |
| DUAL BEAT 双键击鼓 | 红色按 F / J，蓝色按 D / K，或点击红／蓝触控键 |
| ORBIT 单键轨道 | 星球抵达下一格时按 Space，或点击画面／大触控键 |

Esc 暂停／继续。切后台自动暂停；继续时倒数一秒。首次默认轻松难度，并记住上次曲目、模式和难度。PERFECT 窗口为 ±70 ms，GOOD 为 ±150 ms；结算的“正拍 ±25 ms”用于额外节奏分析，不改变评分。提前为负、偏晚为正；样本只包含已命中的音符。

## v1.1 改进

- 安静的大厅 BGM，首个有效交互后自动启动；音乐／击打音效独立音量与静音，保留原设置。
- 暂停、返回大厅、试听与重开统一协调声音；音频系统挂起后先恢复时钟，取消过期的异步恢复。
- 提前／偏晚毫秒提示、连击、结算节奏分布、平均偏差与稳定度。
- 单键轨道镜头连续移动，四键透视轨道触控映射改进。
- 手机横屏扩大游戏画布，44 px 关键触控目标，安全区与可滚动结算面板。

## 源码结构

- `dist/app.js`：页面、曲库、设置、成绩和游戏状态切换。
- `dist/game.js`：音频时钟驱动的判定、输入、画布和节奏统计。
- `dist/audio.js`：原创音乐合成、谱面生成、独立音乐与音效通道。
- `dist/menu-music.js`：大厅音乐生命周期和异步取消。
- `dist/preferences.js`：旧设置兼容与损坏设置恢复。
- `tests/`：音频状态、谱面／计分、暂停恢复竞态、大厅音乐与设置测试。

`dist` 是未经压缩的完整源码，不是缺失工程的编译输出。可以直接修改并刷新。

## 存储与兼容性

成绩、收藏、音量和上次选择保存在当前域名下的 `pulse.*` localStorage。不会上传或跨设备同步；旧独立 PULSE 域名的纪录不会自动迁移到 Linverse。无法使用存储时仍能游玩，但刷新后不会保留本次修改。

需要 Canvas 2D、Web Audio、OfflineAudioContext、ES modules 和 HTML dialog。浏览器可能限制零交互自动播放；游戏会在真实点击／触摸／键盘交互中恢复音频，不要求额外开启音乐。手机视口验证不等于 iOS/Safari 真机音频验证。参考 [MDN 自动播放指南](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay) 与 [AudioContext.resume](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/resume)。

## 许可证与素材

代码、原创 SVG、程序合成曲目与谱面采用 [MIT](LICENSE)，版权属于 Lin Yang。外部字体信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。不包含商业游戏的歌曲、角色、美术或代码。

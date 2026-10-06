# 叶烨 · 作品集（GitHub Pages 静态版）

AI 产品经理作品集。**纯静态、零构建**，推上去开 GitHub Pages 就能用。

## 目录里有什么

| 文件 | 说明 |
|---|---|
| `index.html` | 作品集本体（单文件，样式 / 图片全部内联，无外链） |
| `audit-console.html` | Case 01 端 01 · 商品信息审核裁决台（自包含真机原型） |
| `merchant-portal.html` | Case 01 端 02 · 商家补证端（自包含真机原型） |
| `static/cloud-bridge.js` | 云服务桥接层（会自己定位同级的 `static/vendor/`） |
| `static/vendor/workbuddy-cloud.global.js` | 云 SDK 副本（本地优先，加载失败才回退 CDN） |
| `.nojekyll` | **别删** —— 删了 GitHub 的 Jekyll 会吞掉部分文件 |

> **Case 02「大促资源分配推演台」不在这个包里。** 它有 Python 后端（FastAPI + 规则引擎 + 三服务），
> GitHub Pages 只能发静态文件，跑不了。所以作品集里那个入口直接指向线上那套：
> https://e4c0fdd067fd4093a62990e14e8ea091.app.workbuddy.host/

## 怎么发布

```bash
cd portfolio-pages
git init -b main
git add .
git commit -m "portfolio site"
git remote add origin git@github.com:<你的ID>/<仓库名>.git
git push -u origin main
```

然后：仓库 **Settings → Pages → Source** 选 `Deploy from a branch` → 分支 `main` / 目录 `/ (root)` → Save。

- 普通仓库 → 地址是 `https://<你的ID>.github.io/<仓库名>/`
- 想拿到最短的 `https://<你的ID>.github.io/` → 仓库名取成 `<你的ID>.github.io`

包内所有引用都写成相对路径（`./static/...`、`./audit-console.html`），
所以**上层带不带子路径都能跑**，两种仓库命名都不用改文件。

## 两个已知行为

1. **作品集底部那块「真实运行数据」依赖云数据库**（跨域请求到线上那套的云服务）。
   取不到数据时整块自动隐藏，页面其余部分完全不受影响 —— 不会白屏、不会弹错。
2. 第一个 Demo 入口会跳转到上面那个 WorkBuddy 地址；页面加载后还会在后台悄悄预热一次实例，
   点开时不用现场等冷启动。

## 别把整个 `联调接入` 目录推上来

那个目录里还有工作用的 PRD、交接文档和部署包。这个 `portfolio-pages/` 是专门挑出来、
可以安全公开的静态子集。

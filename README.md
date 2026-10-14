# prototype-annotation-editor

可复用的自研原型标注编辑器 Codex Skill，包含完整运行时代码、安装与诊断脚本、接入说明和数据格式说明。

适用于 React + Vite 原型项目；标注查看可进入发布构建，编辑和文件保存仅在本地 Vite 开发环境开放。

## 功能

- 可视化框选、稳定 DOM 锚点与百分比区域定位。
- 标注卡片与页面标记联动、按当前页面过滤。
- 富文本、图片粘贴、表格编辑与 HTML 清理。
- 标注人独立数据文件、调整版本与版本概览。
- 本地文件保存、重复安装、更新冲突检查与接入诊断。

## 安装到 Codex

选择以下一种方式。目标目录应尚不存在；已有安装请先检查本地修改，避免覆盖。

### 个人安装：在其他项目中复用

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/Yivone/prototype-annotation-editor.git \
  ~/.agents/skills/prototype-annotation-editor
```

### 项目安装：仅在指定项目中使用

在目标项目根目录执行：

```bash
mkdir -p .agents/skills
git clone https://github.com/Yivone/prototype-annotation-editor.git \
  .agents/skills/prototype-annotation-editor
```

Codex 会自动发现技能；若技能列表尚未更新，重启 Codex。

## 使用

在目标项目中向 Codex 发送：

```text
使用 $prototype-annotation-editor，把自研标注功能接入当前项目的
src/prototypes/example-prototype 原型，完成安装、入口挂载、Vite 配置和验证。
```

Codex 会按 [SKILL.md](SKILL.md) 读取项目布局，部署自带运行时，接入原型入口和 Vite 保存插件，并检查依赖与运行状态。直接依赖为 `react`、`react-dom`、`lucide-react` 和 Vite。

安装 Skill 后，调用它完成目标项目接入，即可在原型页面中使用标注功能。具体工作区选择器、布局类名和标注人 ID 会按目标项目确定。

更新已接入项目时，可要求 Codex：

```text
使用 $prototype-annotation-editor，更新当前原型的自研标注编辑器并验证接入。
保留现有标注数据与项目定制。
```

安装器会检查运行时是否被人工修改；存在冲突时默认停止。只有明确同意覆盖后才使用 `--force`。已有标注数据不会被安装器覆盖。

## 仓库内容

| 路径 | 用途 |
| --- | --- |
| `SKILL.md`、`agents/openai.yaml` | 技能说明与 Codex 入口 |
| `assets/runtime/` | 自研标注层、富文本编辑器、Markdown 查看器、样式与 Vite 插件 |
| `scripts/install.mjs`、`scripts/doctor.mjs` | 部署、更新检查与接入诊断 |
| `references/integration.md` | 宿主接入契约 |
| `references/data-schema.md` | 标注数据格式 |

本仓库只发布通用技能和运行时，不包含业务原型或实际标注数据。

安装路径与调用方式参考 [Codex 官方 Skills 文档](https://developers.openai.com/codex/skills/)。

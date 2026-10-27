# 对话树（dsh-conversation-tree）

[![npm version](https://img.shields.io/npm/v/dsh-conversation-tree.svg)](https://www.npmjs.com/package/dsh-conversation-tree)
[![license](https://img.shields.io/npm/l/dsh-conversation-tree.svg)](LICENSE)

DeepSeek Harness 客户端插件：在会话列左侧加一条可折叠、可拖宽的**对话树栏**，把对话按「工作区 → 主题 → 对话」组织起来，并直接打开真实会话。

产品的会话列、标题栏、Chat/Trajectory 页签、右栏、输入框都保持原样——对话树只是让出一条栏位覆盖在左侧，不替换任何产品 UI。

## 安装

要求 DSH `>=0.2.1-rc.3`（见 `package.json` 的 `engines.dsh`）。

```sh
dsh plugin --profile web add dsh-conversation-tree
```

或在 DSH 里：**插件 → 发现 → 索引源**，添加本插件的市场索引：

```
https://chriswang.github.io/dsh-plugins-index/index.json
```

安装后重启 App。首装默认折叠：会话列头部出现一枚 28×28 图标，点它展开对话树栏。

## 使用

- **入口**：左侧导航面板行区的「对话树」行（常驻）；或会话头部的图标（仅在栏折叠时出现）。
- **折叠 / 展开**：两个入口都是单向展开；收起用栏内顶栏左上角的「⇤」。展开/折叠状态会被记住。
- **宽度**：拖栏右边缘调整，最小 320px；会话列始终保留自己的最小宽度，不会被挤没。
- **组织**：工作区是一级、主题是节点、会话挂在节点下；支持多个「空间」，每个空间一棵独立的树。
- **搜索**：栏内搜索框（按需展开）检索节点标题/说明、已索引会话标题与会话正文；正文索引在 Host 进程内按需建立。
- **打开会话**：走产品原生导航，对话树高亮、产品当前会话与右栏始终停在同一会话。

## 数据与持久化

- 权威数据由 Host 半身保存：`$DSH_HOME/conversation-map/map.json`，通过 `/conversation-map` RPC 读写，带 revision 乐观锁。
- 浏览器侧只保留迁移备份；从旧版本升级时，浏览器里的本地文档不会被合并，只备份到 `localStorage` 的 `dsh.conversation-map.v1.host-backup`。
- Host 半身不可用时（例如 CLI 环境）自动降级为浏览器本地模式，栏内显示「本地模式」。

## 模型工具

插件向 harness 注册 9 个工具，模型可以直接读写这棵树：

| 工具 | 作用 |
| --- | --- |
| `map_list_workspaces` | 列出工作区 |
| `map_get_state` | 读取当前文档（工作区、节点、空间、会话归属） |
| `map_plan_goal` | 一次创建「目标 + 策略 + 任务」结构 |
| `map_create_nodes` | 创建节点 |
| `map_update_nodes` | 重命名 / 改描述 |
| `map_move_nodes` | 改父节点或同级排序 |
| `map_move_session` | 把会话归入节点或改名/移动 |
| `map_attach_sessions` | 把已有会话挂到节点下 |
| `map_delete_nodes` | 删除节点（含子树） |

## 已知限制

- **依赖产品的公开 DOM 约定**：帧级 `shell.overlay` 槽（画栏）、渲染器 `[data-slot="main.conversation"] > div` 锚点（写 `padding-left`）、会话头 leading 席位（折叠态入口）、帧上的 `data-sidebar-collapsed` 标记（收起左栏）。产品若改这些结构，栏会退化为「暂不可用」提示而不是覆盖会话列；常驻的面板行入口不受影响。
- **左侧带槽位只有一个**：与其他带插件通过公开属性 `html[data-dsh-band-owner]` 协商，占用时本插件不在会话头重复插入入口（面板行仍可用）。
- **拖拽范围有限**：节点靠 `⋯` 菜单改父节点，不做拖拽；空间不支持拖拽排序。
- **跨工作区移动会话不支持**：Host 的排序只作用于同一工作区。
- **单写者**：同一 `$DSH_HOME` 被多个进程同时写时以后写者为准。
- **搜索范围**：节点标题/说明、已索引会话标题、会话正文（仅 user/assistant 文本，不含系统提示与工具调用）；不支持模糊、分词与拼音。
- **界面文案目前只有中文**（包内已提供 `locale/zh.json`、`locale/en.json` 的展示元数据）。

## 从源码构建

发布到 npm 的是预构建产物（`lib/`），安装时不需要构建。从源码构建需要一份 DSH 源码 checkout，因为本工程刻意不带 npm 依赖，构建器（tsdown）与类型声明（tsc、React 类型）从该 checkout 借用：

```sh
export DSH_CHECKOUT=/path/to/deepseek-harness
export DSH_TYPES_ROOT=/path/to/node_modules   # 含 @types/react 的目录，可选
npm run build      # 生成 lib/index.js 与 lib/client.js
npm test           # node --test，先 build 再跑
npm run check      # typecheck + test
```

## 许可

MIT，见 [LICENSE](LICENSE)。

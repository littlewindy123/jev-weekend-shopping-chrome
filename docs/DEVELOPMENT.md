# 原理与开发

## 输入和决策

扩展读取当前可见商品卡片的文字，发送到 TypeSafe 官方 JEV。请求只有六个白名单字段：`platform`、`product_id`、`product_title`、`shop_name`、`brand_name`、`shop_description`，缺失字段留空。

模型优先参考公司、店铺，其次品牌、制造商，最后按产品和品类猜测。商品图片不发送给模型，也不联网搜索企业排班资料。

仅两个分类：`no_weekend` 对应盖 PASS；`weekend` 对应保持原样。单休、大小周归入非双休；信息有限时依然选择更可能的一项。请求错误单独处理，不视为任何分类结果。

## 本地开发

运行扩展无需构建。测试需要 Node.js 22+：

```bash
npm test
npm install
npx playwright install chromium
npm run test:browser
```

`demo.html` 是使用虚构商品与模拟结果的开发诊断页，不是日常使用入口。使用者直接打开商城即可。

## 主要文件

| 文件 | 用途 |
| --- | --- |
| `adapters.js` | 提取京东、淘宝商品卡片的可见文字 |
| `content.js` / `stamp.css` | 观察可见商品，更新印章和运行统计 |
| `background.js` | 官方请求、Key 存储、缓存、队列和错误处理 |
| `core.js` / `config.js` | 输入白名单、分类提示词、固定模型与接口 |
| `popup.*` | 开关、连接测试和状态面板 |

测试范围和实测记录见 [TESTING.md](TESTING.md)。提交 Issue 时，请提供版本、页面类型及不含个人信息的截图，不要提供 API Key 或 Cookie。

[返回项目首页](../README.md)

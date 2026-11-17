---
question: 浏览器本地存储作为「用户排过的顺序」的唯一副本，能承担多少（localStorage / IndexedDB / Storage API 的配额、异步代价、驱逐与过期规则）
date: 2026-11-17
阅读日期: 2026-11-17（本轮所有 URL 均为该日真实抓取，逐条标注证据等级）
method: 只取一手来源——WHATWG 规格原文（html.spec.whatwg.org / storage.spec.whatwg.org）、MDN 官方文档、WebKit 官方博客与追踪防护政策页、web.dev（Google/Chrome 团队官方文档站）、Chromium 官方设计文档（Google Doc，作者为 Chromium 引擎工程师）。不含第三方博客。
status: localStorage/IndexedDB/Storage API 的配额与驱逐规则均已引一手原句；各引擎 localStorage 的**实测**上限与 Chrome 是否在存储压力下清 localStorage 列入「待核实」
---

# 浏览器本地存储作为排序唯一副本： durability 一手证据

## 结论摘要（TL;DR）

1. **配额不是风险，尺寸差 3 个数量级。** WHATWG Storage 规格把 `localStorage` 这个 endpoint 的配额直接写死为 `5 × 2^20 (i.e., 5 mebibytes)`，而 `indexedDB` / `caches` / `serviceWorkerRegistrations` 三个 endpoint 的配额列是 `null`（即无独立上限，受 shelf 总量约束）。
   来源 [一手]：https://storage.spec.whatwg.org/ §4.1 "registered storage endpoints" 表
2. **在 Chrome 里 localStorage 根本不在 QuotaManager 的记账与驱逐体系内**：Chromium 官方设计文档原句 "e.g. local storage is not quota-managed data; each origin has a 10MB limit"。文档的 "Eviction / Storage Expiration" 两节只描述 quota-managed bucket（"When an origin's bucket is evicted, all of its quota-managed data (Indexed DB, Cache API, etc) is deleted."、"If the bucket for an origin hasn't been accessed in over 400 days, it will be deemed as expired and the bucket will automatically be evicted."）。也就是说 **400 天过期与 LRU 驱逐这两条明确打在 IndexedDB 上，而未在文档中对 localStorage 作出同等承诺**（这一点属推断，见「待核实」）。
   来源 [一手]：https://docs.google.com/document/d/19QemRTdIxYaJ4gkHYf2WWBNPbpuZQDNMpUVf8dQxj4U/edit （"Key Concepts"、"Eviction"、"Retention Lifetimes" 节）
3. **真正的杀手是 WebKit/Safari 的 ITP 七天上限，且它明确点名 LocalStorage。** WebKit 政策页原句："ITP deletes all cookies created in JavaScript and all other script-writeable storage after 7 days of no user interaction with the website. The latter storage forms are: IndexedDB / LocalStorage / Media keys / SessionStorage / Service Worker registrations and cache"。而「user interaction」的定义排除了滚动："User interaction is a user click, tap, or keyboard entry on a website. Some refer to it as a user gesture. Scrolling is not considered user interaction."
   来源 [一手]：https://webkit.org/tracking-prevention/ §"7-Day Cap on All Script-Writeable Storage"、§"Terminology"
   **[主会话核对 2026-11-17，同一页 curl 原文] 上面那句的主语是 trackers，整句是：“Trackers executing script in the first-party context often make use of first-party storage to save and recall cross-site tracking information. Therefore, ITP deletes all cookies created in JavaScript and all other script-writeable storage after 7 days of no user interaction with the website.”，且同页把 “7-day cap” 画在 “tracker.example (3p cloaking)” 那一行下、对 “No cloaking” 写 “No cap”。⇒ 本条应按**条件性风险**读：一个不被归类为 tracker 的自有域名是否也吃这条上限，本轮没有一手依据，别按「Safari 一律七天清空本地存储」写进任何决策或文案。引文缺失的主语是本轮唯一由主会话补正的一处。
4. **`navigator.storage.persist()` 保证的东西比直觉少一半。** 规格只保证「UA 不能在无 origin 或用户参与下清除」："The user agent cannot clear storage marked as persistent without involvement from the origin or user."；而 Chrome 文档直接写明反向的那一半："Explicit clearing (by the user or site) overrides any persistence guarantees (e.g. persistence permission)."。授权本身是启发式的：Chrome 无提示地静默批准/拒绝（site engagement、是否安装或加书签、是否拿到通知权限），WebKit 则 "grants a request based on heuristics like whether the website is opened as a Home Screen Web App"。
   来源 [一手]：https://storage.spec.whatwg.org/ §5；https://web.dev/articles/persistent-storage ；https://webkit.org/blog/14403/updates-to-storage-policy/
5. **豁免条款是 WebKit 侧唯一成体系的解法，且它不是 `persist()`。** 主屏 Web App 域名被结构性排除："the first-party domain of home screen web applications is exempt from ITP's 7-day cap on all script-writeable storage, i.e. ITP always skips that domain in its website data removal algorithm."
   来源 [一手]：https://webkit.org/tracking-prevention/ §"Home Screen Web Application Domain Exempt From ITP"
6. **localStorage 的同步性在规格里是可证的，不是风格判断**：`Storage` 的 IDL 是 `getter DOMString? getItem(DOMString key); setter undefined setItem(DOMString key, DOMString value);`——无 Promise。规格同时明确**没有跨进程加锁**："authors are encouraged to assume that there is no locking mechanism"，并给出两个窗口同时读-增-写会撞号的例子，结尾 "with potentially disastrous effects"。多标签页写顺序的竞态在规范层面是**已知未解**问题。
   来源 [一手]：https://html.spec.whatwg.org/multipage/webstorage.html §12.2.1、§12.1
7. **`estimate()` 的量出来的东西也不含 localStorage。** 规格的 `StorageEstimate` 字典只有 `usage` 与 `quota` 两个成员（`usageDetails` 是非标准的引擎扩展）；web.dev 描述 Chrome 行为为 "It reports the total number of bytes used by IndexedDB and the Cache API"。想靠 `estimate()` 自检排序键写没写成，是拿不到的。
   来源 [一手]：https://storage.spec.whatwg.org/ §"StorageEstimate" 字典；[非一手，Google 官方文档站但对 Safari 段自认无官方依据]：https://web.dev/articles/storage-for-the-web
8. **官方对「被自动清除」的频率判断是低的，但同一段话把更大的实际风险指向了用户手动清除**："research by the Chrome team shows that data is very rarely cleared automatically by Chrome. It is far more common for users to manually clear storage." Chromium 设计文档重复了同一结论。MDN 的 IndexedDB 篇也把「用户请求清除」列为第一条被抹条件。
   来源 [一手]：https://docs.google.com/document/d/19QemRTdIxYaJ4gkHYf2WWBNPbpuZQDNMpUVf8dQxj4U/edit ；https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria ；https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology

## 1. localStorage：同步语义、每 origin 配额、什么会过期

### 1.1 同步 / 异步 [一手]

规格 `Storage` 接口定义（https://html.spec.whatwg.org/multipage/webstorage.html §12.2.1）：

> `[Exposed=Window] interface Storage { readonly attribute unsigned long length; DOMString? key(unsigned long index); getter DOMString? getItem(DOMString key); setter undefined setItem(DOMString key, DOMString value); deleter undefined removeItem(DOMString key); undefined clear(); };`

全部为同步返回，无 Promise。Google/Chrome 官方文档站的取舍表述（https://web.dev/articles/storage-for-the-web ，"What about other storage mechanisms?" 节，Last updated 2024-09-23）：

> "LocalStorage should be avoided because it is synchronous and will block the main thread. It is limited to about 5MB and can contain only strings. LocalStorage is not accessible from web workers or service workers."

值的编码：MDN https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage （页脚 Document last modified 2026-10-12）原句 "The keys and the values stored with `localStorage` are in the [UTF-16] string format." 同一页给出 "the stored data is saved across browser sessions." 以及 "while `localStorage` data has no expiration time, `sessionStorage` data gets cleared when the page session ends"。

同页还写明两件事对本项目直接相关：origin 按协议分裂——"for a site loaded over HTTP (e.g., `http://example.com`), `localStorage` returns a different object than `localStorage` for the corresponding site loaded over HTTPS"；以及受限上下文直接抛：`SecurityError` DOMException，"The request violates a policy decision. For example, the user has configured the browsers to prevent the page from persisting data." + "Note that if the user blocks cookies, browsers will probably interpret this as an instruction to prevent the page from persisting data."

### 1.2 每 origin 配额：三份一手数值互相不完全一致

| 来源 | localStorage 数值 | 证据等级 |
|---|---|---|
| WHATWG Storage 规格 §4.1 endpoint 表：`"localStorage"` / type `« "local" »` / Quota `5 × 220 (i.e., 5 mebibytes)`；`"sessionStorage"` 同为 5 MiB | 5 MiB | [一手] https://storage.spec.whatwg.org/ |
| MDN「Storage quotas and eviction criteria」"Web Storage" 节："Web Storage … is limited to 10 MiB of data maximum on all browsers." 紧接 "Browsers can store up to 5 MiB of local storage, and 5 MiB of session storage per origin." 及 "Once this limit is reached, browsers throw a `QuotaExceededError` exception" | local 5 MiB + session 5 MiB = 10 MiB | [一手] https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria （last modified 2026-01-05） |
| Chromium 官方设计文档（jsbell@chromium.org / ayui@chromium.org，Last Updated 2024-10-11）："e.g. local storage is not quota-managed data; each origin has a 10MB limit" | 10 MB | [一手] https://docs.google.com/document/d/19QemRTdIxYaJ4gkHYf2WWBNPbpuZQDNMpUVf8dQxj4U/edit |
| web.dev "Storage for the web"："It is limited to about 5MB"（措辞为 about，同段也用于 sessionStorage） | 约 5 MB | [非一手] 同上表最后一列；该页在 Safari 段落自认 "I was unable to find any official documentation on this." |

**规格与 Chromium 文档的 5 MiB vs 10 MB 差异没有一手来源可以调和**，本轮未确认，见「待核实」第 1 条的实测配方。三处都同意的只有量级：MiB 级、且与 IndexedDB 的「按磁盘百分比」配额是两套账。

异常语义 [一手]（https://html.spec.whatwg.org/multipage/webstorage.html §12.2.1 setItem 注）：

> "Throws a QuotaExceededError if the new value couldn't be set. (Setting could fail if, e.g., the user has disabled storage for the site, or if the quota has been exceeded.)"

### 1.3 存什么会过期：规格明确授权 UA 定时清除 [一手]

https://html.spec.whatwg.org/multipage/webstorage.html §12.3.1 "Expiring stored data"：

> "User agents may, possibly in a manner configured by the user, automatically delete stored data after a period of time."
> "However, this also reduces the usefulness of the API as a long-term storage mechanism. It can also put the user's data at risk, if the user does not fully understand the implications of data expiration."

WebKit 那边还额外写明了「为什么需要这个上限」——localStorage 没有过期原语（https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ ，Mar 24, 2020，John Wilander）：

> "APIs like LocalStorage have no expiry function at all, i.e. websites cannot even ask browsers to put a limit on how long such storage should stay around."

同节还列出：`localStorage` **不能**放进 iframe 的第三方上下文里指望它活着——"Third-party LocalStorage and IndexedDB are partitioned per first-party website and also made ephemeral."（https://webkit.org/tracking-prevention/ §"Partitioned Third-Party Storage"）

### 1.4 隐身/隐私模式（各引擎分别说）

- MDN（跨引擎总述，[一手]）："(localStorage data for a document loaded in a "private browsing" or "incognito" session is cleared when the last "private" tab is closed.)" — https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage
- MDN 配额篇（[一手]）："in private browsing mode (also called *Incognito* in Chrome, and *InPrivate* in Edge), browsers may apply different quotas, and stored data is usually deleted when the private browsing mode ends."
- Chromium 设计文档（[一手]）：隐身是独立 Browsing Context，且"quota-managed data is (usually) stored in memory rather than on disk. The temporary pool is calculated as the minimum of 10% of system memory or 300MB (randomized by 10% to prevent fingerprinting). Each origin is given up to ⅓ of that."
- web.dev（[非一手]，且与上一条冲突）："In incognito mode, Chrome reduces the amount of storage an origin can use to approximately 5% of the total disk space." — https://web.dev/articles/storage-for-the-web 。**设计文档（2024-10-11）比 web.dev（2024-09-23）更晚更新，本轮按设计文档为准。**
- WebKit（[一手]）："Safari's Private Browsing Mode uses a new ephemeral session for each tab the user opens to isolate tabs from each other."，且 ephemeral 定义为 "the storage does not persist to disk and goes away with the application, for instance when the user quits the browser or reboots their device." — https://webkit.org/tracking-prevention/ §"Private Browsing Mode"
- MDN「Using the Web Storage API」（[一手]，last modified 2026-05-26）关于可用性探测的警告：for a document viewed in a browser's private browsing mode, some browsers might give us an empty `localStorage` object with a quota of zero, effectively making it unusable." — https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API/Using_the_Web_Storage_API

## 2. IndexedDB 相对 localStorage：配额、驱逐、异步代价

### 2.1 配额走的是另一套（按磁盘百分比） [一手]

规格层面 `indexedDB` endpoint 的 Quota 列是 `null`，并配文（https://storage.spec.whatwg.org/ §4.6）：

> "A storage bottle also has a quota, which is null or a number representing a conservative estimate of the total amount of bytes it can hold. Null indicates the lack of a limit. It is still bound by the storage quota of its encompassing storage shelf."

MDN 把这条分界线说破了（https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria ，"Other web technologies" 节）：

> "The data that's stored by using other web technologies, such as IndexedDB, Cache API, or File System API (which defines the Origin Private File System), is managed by a storage management system that's specific to each browser."

各引擎的这套「specific to each browser」配额，同一页原文数值：

- Firefox："10% of the total disk size where the profile of the user is stored" 与 "10 GiB, which is the *group limit* that Firefox applies to all origins that are part of the same [site]" 取小者；persistent 下 "can store up to 50% of the total disk size, capped at 8 TiB, and are not subject to the group limit"；并注明 "it is calculated based on the hard drive **total** size, not the currently available disk space. This is done for security reasons, to avoid [fingerprinting]"。
- Chrome/Chromium："an origin can store up to 60% of the total disk size in both persistent and best-effort modes."（Chromium 设计文档给出更底层的算式："the total pool size is 80% of the disk, and each storage key can use at most 75% of that"——0.8 × 0.75 = 0.6，两处一致。）
- Safari："For WebKit-based browser apps, each origin can store up to around 60% of total disk"，"For other WebKit-based apps that embed web content, each origin can store up to around 15% of total disk"，"cross-origin frames have a separate quota, amounting to roughly 1/10 of their parents"，另有 overall quota "80% of disk size for browser apps, and 20% of disk size for non-browser apps"。
- 注意 MDN 自己给这些配额留了不精确出口："Like with Firefox, because this quota is calculated based on the hard drive total size to avoid fingerprinting, an origin might not actually be able to reach its quota." / "the exact limits enforced by the quota may vary so as to avoid fingerprinting."

web.dev 上的 Firefox 数字（"up to 50% of free disk space"、"An eTLD+1 group … may use up to 2GB"）与 MDN 的 10%/10 GiB **直接冲突**，且 web.dev 属 [非一手]，本轮不采信。

### 2.2 驱逐规则 [一手]

- MDN 三条触发条件："When the device is running low on storage space, also known as *storage pressure*." / "When all of the data stored in the browser (across all origins) exceeds the total amount of space the browser is willing to use on the device." / "Proactively, for origins that aren't used regularly, which happens only in Safari."
- LRU 与 persistent 豁免："Browsers use a Least Recently Used (LRU) policy to deal with this scenario. The data from the least recently used origin is deleted. … This eviction mechanism only applies to origins that are not persistent and skips over origins that have been granted data persistence by using `navigator.storage.persist()`."
- 原子性："When an origin's data is evicted by the browser, all of its data, not parts of it, is deleted at the same time. If the origin had stored data by using IndexedDB and the Cache API for example, then both types of data are deleted." —— 这条对设计有实际含义：不存在「缓存被清但顺序留着」这种半态。
- Chrome 额外的一条硬期限（Chromium 设计文档 "Storage Expiration" 节，[一手]）："If the bucket for an origin hasn't been accessed in over 400 days, it will be deemed as expired and the bucket will automatically be evicted."
- WebKit 的 LRU 计时定义更具体（https://webkit.org/blog/14403/updates-to-storage-policy/ ，[一手]）："The ordering of origins to be deleted is decided using a least-recently-used policy. The last use time is the time of the last user interaction, or the time of the last storage operation." 以及 "Origin might be excluded from eviction if it has active page at the time of eviction, or its storage is in persistent mode."
- MDN IndexedDB 篇列的抹除面（[一手]）："The user requests a wipe out. Many browsers have settings that let users wipe all data stored for a given website, including cookies, bookmarks, stored passwords, and IndexedDB data." / "The browser is in private browsing mode. … At the end of the session, the browser wipes out the database." / "The disk or quota limit has been reached." / "The data is corrupt." / "An incompatible change is made to the feature." 收口一句："the general philosophy of the browser vendors is to make the best effort to keep the data when possible."

### 2.3 异步代价（不是「慢一点」这么简单） [一手]

MDN https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology （last modified 2026-09-04；URL 从旧名 `Basic_Concepts_Behind_IndexedDB` 301 到该页，面包屑标题为 "IndexedDB key characteristics and basic terminology"）：

> "The IndexedDB API is mostly asynchronous. The API doesn't give you data by returning values; instead, you have to pass a callback function. You don't "store" a value into the database, or "retrieve" a value out of the database through synchronous means. Instead, you "request" that a database operation happens. You get notified by a DOM event when the operation finishes, and the type of event you get lets you know if the operation succeeded or failed."

对本项目最硬的一条是事务生命周期：

> "Transactions are expected to be short-lived, so the browser can terminate a transaction that takes too long, in order to free up storage resources that the long-running transaction has locked."

以及「读顺序」与「渲染」之间会插入异步跳，规格层没有同步读路径。durability 也不是直觉的那样（同页 "durable" 条）：

> "the `complete` event is fired after the OS has been told to write the data but potentially before that data has actually been flushed to disk. … there exists a small chance that the entire transaction will be lost if the OS crashes or there is a loss of system power before the data is flushed to disk."

Firefox 另留了一个非标准出口："you can force a transaction to flush to disk before delivering the `complete` event by creating a transaction using the experimental (non-standard) `readwriteflush` mode" —— "can only be used if the `dom.indexedDB.experimental` pref is set to `true` in `about:config`."

规格侧对 IndexedDB 的定位与本用例吻合（同页 "Key characteristics"）："IndexedDB is useful for applications that store a large amount of data … and applications that don't need persistent internet connectivity to work (for example, mail clients, to-do lists, and notepads)."

## 3. Storage API / `navigator.storage.persist()` 到底保证什么

### 3.1 语义与授权路径 [一手]

规格（https://storage.spec.whatwg.org/ §4.5、§5）：

> "A local storage bucket has a mode, which is "best-effort" or "persistent". It is initially "best-effort"."
> "A local storage bucket can only have its mode change to "persistent" if the user (or user agent on behalf of the user) has granted permission to use the "persistent-storage" powerful feature."
> "When granted to an origin, the persistence permission can be used to protect storage from the user agent's clearing policies. The user agent cannot clear storage marked as persistent without involvement from the origin or user."

关键限定词是 **without involvement from the origin or user**——用户点「清除站点数据」就是那个 involvement，所以 persistent 不是「不许删」，而是「UA 不得单方面删」。这一点 Chromium 文档说得最直白（[一手]）：

> "Explicit clearing (by the user or site) overrides any persistence guarantees (e.g. persistence permission)."

MDN `StorageManager/persist()`（last modified 2026-10-12，[一手]）：

> "requests permission to use persistent storage, and returns a Promise that resolves to `true` if permission is granted and bucket mode is persistent, and `false` otherwise. The browser may or may not honor the request, depending on browser-specific rules."

同一页的三条硬约束值得逐条记下：`Secure context` — "This feature is available only in secure contexts (HTTPS), in some or all supporting browsers."；Worker 可用性 — "This method is not available in Web Workers, though the `StorageManager` interface is."；异常 — `TypeError` "Thrown if obtaining a local storage shelf failed. For example, if the current origin is an opaque origin or if the user has disabled storage." 撤销路径（规格 §5 permission revocation algorithm）：撤销即 "Set shelf's bucket map["default"]'s mode to "best-effort"."

web.dev（[非一手]，但为 Chrome 团队官方文档站；Last updated 2020-05-12）给出授权启发式（https://web.dev/articles/persistent-storage ）：

> "Chrome, and most other Chromium-based browsers automatically handle the permission request, and do not show any prompts to the user. Instead, if a site is considered important, the persistent storage permission is automatically granted, otherwise it is silently denied."
> 启发式清单："How high is the level of site engagement?" / "Has the site been installed or bookmarked?" / "Has the site been granted permission to show notifications?"
> "If the request was denied, it can be requested again later and will be evaluated using the same heuristics."
> Firefox 相反："Firefox delegates the permission request to the user. When persistent storage is requested, it prompts the user with a UI popup."
> 撤销："At this time, there is no programmatic way to tell the browser you no longer need persistent storage."

MDN 配额篇对提示与否的表述与之一致（[一手]）："Safari and most Chromium-based browsers, such as Chrome or Edge, automatically approve or deny the request based on the user's history of interaction with the site and do not show any prompts to the user." / "In Firefox, when a site chooses to use persistent storage, the user is notified with a UI popup that their permission is requested."

WebKit 的具体启发式（[一手]，https://webkit.org/blog/14403/ ）："WebKit currently grants a request based on heuristics like whether the website is opened as a Home Screen Web App." —— 换句话说 WebKit 侧真正拿到 persistent 的路径基本就是安装到主屏。

### 3.2 `persist()` 覆盖哪些存储类型

web.dev（[非一手]）列了保护范围（"What storage is protected by persistent storage?"）："Cache API / Cookies / DOM Storage (Local Storage) / File System API … / IndexedDB / Service workers / App Cache (deprecated) / WebSQL (deprecated)"。规格 §7.1 的措辞是按 bucket 而非按 API："A user agent that comes under storage pressure should clear network state and local storage buckets whose mode is "best-effort", ideally prioritizing removal in a manner that least impacts the user." 并留了升级路径："If a user agent continues to be under storage pressure, then the user agent should inform the user and offer a way to clear the remaining local storage buckets, i.e., those whose mode is "persistent"." —— 即规格自己承认 persistent 在极端压力下也可能被清，只是要先告知用户。

**本轮未取得一手来源证明「Safari 的 `persist()` 能挡住 ITP 的七天清除」**：WebKit 政策页的 7 天条款未提 persistent，而 blog/14403 的 persistent 豁免出现在 generic eviction 段。见「待核实」第 3 条。

### 3.3 默认配额与可用上限怎么算（`estimate()`）

- 规格定义（https://storage.spec.whatwg.org/ §6，[一手]）："The storage quota of a storage shelf is an implementation-defined conservative estimate of the total amount of bytes it can hold. This amount should be less than the total storage space on the device. **It must not be a function of the available storage space on the device.**" / "The storage usage of a storage shelf is an implementation-defined rough estimate … user agents might, and are encouraged to, use deduplication, compression, and other techniques that obscure exactly how much bytes a storage shelf uses."
- 规格还规定了配额应当随行为变化（同节，[一手]）："User agents are strongly encouraged to consider navigation frequency, recency of visits, bookmarking, and permission for "persistent-storage" when determining quotas." 以及反指纹动机："Directly or indirectly revealing available storage space can lead to fingerprinting"。
- MDN `StorageManager/estimate()`（last modified 2026-10-12，[一手]）：`quota` = "A numeric value in bytes which provides a conservative approximation of the total storage the user's device or computer has available for the site origin or Web app. It's possible that there's more than this amount of space available though you can't rely on that being the case."；"The returned values are not exact: between compression, deduplication, and obfuscation for security reasons, they will be imprecise."；quota 逐 origin 不同的依据是 "How often the user visits / Public site popularity data / User engagement signals like bookmarking, adding to homescreen, or accepting push notifications"。该特性 "available in Web Workers"，同样是 secure context only。
- **`estimate()` 里 `usageDetails` 不是标准成员**（[一手]）：规格的 `dictionary StorageEstimate` 只有 `unsigned long long usage; unsigned long long quota;`。MDN 文档写了 "usageDetails: An object containing a breakdown of usage by storage system"，属引擎扩展。
- Chromium 文档补了一条对「用 quota 当可用性判据」的直接警告（[一手]）："Starting in M81, free disk space is no longer factored into the quota calculation. The quota returned by navigator.storage.estimate() reports the maximum amount of space the quota system will allow the storage key to write, but does not guarantee that much disk space to be available. It is possible that reported quota will be greater than free disk space available, so origins should always handle out-of-disk-space write errors gracefully."
- 开发期模拟入口（web.dev，[非一手]）："A new feature was added in Chrome 88 that lets you override the site's storage quota in the Storage Pane … Go to Application then Storage, enable the Simulate custom storage quota checkbox"。

## 4. 已知驱逐场景（引官方原句）

### 4.1 Safari / WebKit 对脚本可写存储的时间上限

https://webkit.org/tracking-prevention/ §"7-Day Cap on All Script-Writeable Storage"（[一手]）：

> "Trackers executing script in the first-party context often make use of first-party storage to save and recall cross-site tracking information. Therefore, ITP deletes all cookies created in JavaScript and all other script-writeable storage after 7 days of no user interaction with the website. The latter storage forms are: • IndexedDB • LocalStorage • Media keys • SessionStorage • Service Worker registrations and cache"

触发条件里的「interaction」定义（同页 §Terminology，[一手]）：

> "User interaction is a user click, tap, or keyboard entry on a website. Some refer to it as a *user gesture*. Scrolling is not considered user interaction."

MDN 的对应转述（[一手]，§"Proactive eviction"）：

> "Safari proactively evicts data when cross-site tracking prevention is turned on. If an origin has no user interaction, such as click or tap, in the last seven days of browser use, its data created from script will be deleted. Cookies set by server are exempt from this eviction."

原始公告（https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ ，Mar 24, 2020，[一手]）：

> "ITP has aligned the remaining script-writable storage forms with the existing client-side cookie restriction, deleting all of a website's script-writable storage after seven days of Safari use without user interaction on the site."

豁免（两处，[一手]）：

> https://webkit.org/tracking-prevention/ §"Home Screen Web Application Domain Exempt From ITP"："The first-party domain of home screen web applications is exempt from ITP's 7-day cap on all script-writeable storage, i.e. ITP always skips that domain in its website data removal algorithm. In addition, the website data of home screen web applications is kept isolated from Safari and thus will not be affected by ITP's classification of tracking behavior in Safari."
> https://webkit.org/blog/10218/ §"A Note On Web Applications Added to the Home Screen"："Web applications added to the home screen are not part of Safari and thus have their own counter of days of use. Their days of use will match actual use of the web application which resets the timer. We do not expect the first-party in such a web application to have its website data deleted. … It is not the intention of Intelligent Tracking Prevention to delete website data for first parties in web applications."

另需记下 WebKit 的开关依赖：MDN 明写 proactive eviction 的前提是 "when cross-site tracking prevention is turned on"，并把 proactive eviction 定性为 "which happens only in Safari"。

### 4.2 Chrome 的存储压力驱逐

Chromium 设计文档（[一手]）：

> "Storage is by default "best effort"; anything an origin stores will be retained until the browser is low on storage space, at which point the data for the origin least recently accessed will be discarded."
> "The least recently used "best effort" origins (those without the "persistent" permission) start being evicted until Chrome is back under the limit."
> "When an origin's bucket is evicted, all of its quota-managed data (Indexed DB, Cache API, etc) is deleted."

同文档还有一条豁免开关："unlimitedStorage - can be granted to an origin via an extension or kiosk app; this removes quota restrictions and exempts an origin from quota-based eviction"。

### 4.3 隐身 / 隐私窗口

见 §1.4 各引擎原句。补一条与本项目 UX 相关的：Chromium 文档 §"Retention Lifetimes / Incognito & Guest Mode" 写明 "Settings UI (e.g. chrome://settings/clearBrowserData) is NOT available within an Incognito session."——隐身里连用户手动清的路径都不同。

### 4.4 用户清站点数据

- 规格授权 UA 提供此能力（https://storage.spec.whatwg.org/ §7.2，[一手]）："User agents should offer users the ability to clear network state and storage for individual websites. User agents should not distinguish between network state and storage in their user…"（原句在此截断，见 §7.2 全段）
- 规格还警告「只清 cookie 不清 localStorage」会被视为可被绕过（https://html.spec.whatwg.org/multipage/webstorage.html §12.3.1 "Treating persistent storage as cookies"，[一手]）："If users attempt to protect their privacy by clearing cookies without also clearing data stored in the local storage area, sites can defeat those attempts by using the two features as redundant backup for each other. User agents should present the interfaces for clearing these in a way that helps users to understand this possibility and enables them to delete data in all persistent storage features simultaneously."
- Chromium 文档列出的用户侧入口（[一手]）："Clear Browsing Data / Clear Site Data / chrome.browsingData extension API — Allow deletion of specific time ranges (any origin modified within the window is wiped) — UI: chrome://settings/clearBrowserData"；"DevTools — Allows deletion of individual origins / storage types — UI: DevTools > Application > Clear storage > Clear site data"；"Cookies UI ("Cookie Tree") — Allows deletion of individual origins — UI: chrome://settings/content/all"；"Android Storage UI — … LocalStorageInfo.java (localstorage and cookies)"。
- 站点自清（[一手]，同文档 §"Site Initiated"）："`localStorage: localStorage.clear()`"、"`Indexed DB: delete databases, e.g. indexedDB.deleteDatabase(databaseName)`"；以及响应头 "Clear-Site-Data: storage - clears storage key-scoped data (both quota-managed and otherwise) for the response's origin"（本项目的 GitHub/Gitee/Jira token 若走该头会连带清除）。
- 会话型策略（[一手]，同文档 §"Session-Only (a.k.a. "clear on exit")"）："chrome://settings/cookies — "Keep local data only until you quit the browser" - applies to all origins — "Clear on exit" - user/admin configurable site patterns"。web.dev 把这同一策略表述为配额惩罚："If the user has enabled "Clear cookies and site data when you close all windows" in Chrome, the storage quota is significantly reduced to a maximum of approximately 300MB."，Chromium 文档对应句为 "Origins for which the session-only policy is applied are further capped at 300MB (randomized by 10%)"。

### 4.5 浏览器不承诺的其它抹除面（规格明文）

https://storage.spec.whatwg.org/ §7.1（[一手]）："Session storage buckets must be cleared as traversable navigables are closed." 与 HTML 规格 §12.3.1 的总授权句（"User agents may … automatically delete stored data after a period of time"）一起，构成「规格从不承诺任何本地副本必然活着」的规范基线。

## 5. 一个几百字节的 id 数组在这些约束里的位置

现状（本轮读取 [src/panel/manual-order.ts:11-42](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/src/panel/manual-order.ts#L11) 确认）：两个键 `triage360:manual-order:v1` / `triage360:order-notice:v1`，前者值为 `JSON.stringify(ids)`（字符串数组），读写各包一层 try/catch，写失败注释为「写不进去最坏是下次打开回到规则序」。

按上述一手数值定位（**尺寸算法与百分比是我本轮的算术，不是任何文档结论**）：

1. **配额占用可忽略。** 200 个约 30 字符的 id → JSON 文本约 6.4k 字符；按 MDN 的 UTF-16 编码陈述折 2 字节/字符约 12.8 KB。相对规格最严的 5 MiB（5,242,880 B）是 **约 0.24%**；相对 Chromium 文档的 10 MB 是约 0.13%。即使 id 数再涨 10 倍仍在 2.4% 以内。`QuotaExceededError` 在这个尺寸下不是现实故障模式——除非同 origin 的其它 localStorage 键先把 5 MiB 吃掉（MDN [一手]：限制是 per-origin，且 "browsers will probably interpret" 屏蔽 cookie "as an instruction to prevent the page from persisting data"）。
2. **尺寸不是约束，时间才是。** WebKit 的 7 天条款对 LocalStorage 生效且不因值小而豁免（§4.1 原文未设尺寸门槛）。对本用例的实际风险窗口是「连续 7 天 Safari 使用中没有 click/tap/keyboard」——而「打开面板滚动看一眼」按定义**不算** interaction。手动排序本身是 click/drag，会重置计时；只浏览不操作的日子不会。
3. **搬到 IndexedDB 不会换到更长的寿命，只会换一套驱逐条件。** 在 Chrome，规格与设计文档都把 IndexedDB 放进 quota-managed bucket：受 §4.2 的 LRU 压力驱逐与 §4.2 的 400 天 bucket 过期约束，而 localStorage 在同一文档里被明确划在 QuotaManager 之外（"not quota-managed data"）。代价还会加上 §2.3 的异步/事务生命周期与「读顺序要等一个 DOM event」的首屏依赖。换言之：IndexedDB 换来的是「能存结构化对象 + 不阻塞主线程 + worker 可用」，不是「更难被清」。
4. **`persist()` 能买到的具体东西是可以逐条列出的**：挡得住 §4.2 的存储压力 LRU 驱逐（MDN [一手]："This eviction mechanism only applies to origins that are not persistent"；Chromium [一手]："if granted, the origin will not be cleared when the browser is low on space"）；挡不住 §4.4 的用户清除（Chromium [一手]："Explicit clearing … overrides any persistence guarantees"），在 Firefox 会引入一个权限弹窗（MDN [一手]），在 Chrome/WebKit 无提示且可能被静默拒绝（MDN/WebKit [一手]）。挡不挡得住 §4.1 的 Safari 7 天条款：本轮无一手结论。
5. **两个一手来源直接指出「first-party 自用数据」的正解形态是安装态，而不是换存储 API。** WebKit 对 Home Screen Web App 的措辞是 "We do not expect the first-party in such a web application to have its website data deleted. If your web application does experience website data deletion, please let us know since we would consider it a serious bug."；同页另一条给纯前端项目的现实约束是 localStorage 不跨协议/端口分裂之外，MDN 明确 http 与 https 是**两个不同对象**。
6. **竞态是规范层面已知未解的**（§1.1 引的 "no locking mechanism"）。同 origin 多标签页各持一份数组、后写覆盖，规格给的原语只有 `storage` 事件——MDN [一手]："The storage event is fired whenever a change is made to the Storage object of another document that shares the same storage space. This won't work on the same page that is making the changes."

## 待核实（附自证配方）

1. **各引擎 localStorage 的实测上限（5 MiB vs 10 MB 的差异）** [未核实]。规格与 MDN 给 5 MiB，Chromium 设计文档给 10 MB。配方：在目标 origin 控制台跑，观察抛错时累计字符数与浏览器——
   `let n=0; try{ for(let i=0;i<20000;i++){ localStorage.setItem("probe"+i, "x".repeat(1024)); n+=1024; } }catch(e){ console.log(e.name, e.message, "chars stored ≈", n, "≈", (n*2/1048576).toFixed(2), "MiB as UTF-16"); } localStorage.clear();`
   注意 Chrome 与 WebKit 对 UTF-16 计费方式可能不同，两个数字（字符数、字节估算）都要记。
2. **Chrome 是否在存储压力下清除 localStorage** [未核实]。本轮结论（§5 第 3 条）是从「localStorage is not quota-managed data」+「eviction 段只述 quota-managed data」推出来的，属推断。配方：`chrome://settings/clearBrowserData` 与 QuotaManager 行为无法从页面观测，需读 `storage/browser/quota/quota_settings.cc`（Chromium 文档指名："These default quota calculations are defined in storage/browser/quota/quota_settings.cc (but can be overridden for different shells, e.g. chromecast)"）或在低磁盘 VM 里对比 localStorage 键与 IndexedDB 库谁先消失。
3. **Safari 中 `navigator.storage.persist()` 是否豁免 ITP 的 7 天上限** [未核实]。本轮两份 WebKit 一手来源在 7 天条款里都没提 persistent。配方：Safari 控制台 `await navigator.storage.persist(); await navigator.storage.persisted();` 记录返回值，再结合 §4.1 原句判断——注意普通标签页大概率返回 `false`（WebKit 的启发式是 "whether the website is opened as a Home Screen Web App"）。
4. **`navigator.storage.estimate()` 的 `usage` 是否包含本项目那两个 localStorage 键** [未核实，倾向「不含」]。一手支撑：规格 `StorageEstimate` 无 `usageDetails`；web.dev 称 Chrome "reports the total number of bytes used by IndexedDB and the Cache API"；Chromium 文档称 localStorage 非 quota-managed。配方：`localStorage.setItem("big", "x".repeat(1_000_000)); const e = await navigator.storage.estimate(); console.log(e);` 看 `usage` 是否随之跳变，并记下 `usageDetails` 里出现了哪些键。
5. **Firefox 的 localStorage 上限与隐身语义** [未核实]。本轮未取得一手数值（searchfox 的 `raw-file` 端点三次 404，见传输通道说明）。可用一手为 MDN 的跨引擎数值 + web.dev 的 Firefox 段（后者与 MDN 冲突，不采信）。配方：Firefox 隐私窗口跑 §1.4 的探测句：`try{ localStorage.setItem("t","1"); console.log("writable", localStorage.length); }catch(e){ console.log(e.name); }` 并关闭最后一个隐私标签页后在新窗口复查。
6. **`storage.spec.whatwg.org` §7.2 关于 UA 清除 UI 的完整原句** [非一手截断]。本轮只取到前两句，句子在 "…should not distinguish between network state and storage in their user" 处被我的抽取截断。配方：直接打开 https://storage.spec.whatwg.org/#ui-guidelines 读完整段。
7. **本项目部署域名是否满足 secure context（`persist()`/`estimate()` 的前置）** [未核实]。一手依据：MDN 两处 "This feature is available only in secure contexts (HTTPS)"。配方：在实际访问入口执行 `console.log(window.isSecureContext, location.protocol)`——若 owner 走 `file://` 打开，还要连带核对 MDN 那句 "For documents loaded from `file:` URLs … the requirements for `localStorage` behavior are undefined and may vary among different browsers."

## 来源清单

### 一手

- WHATWG HTML Living Standard, Ch.12 Web Storage — https://html.spec.whatwg.org/multipage/webstorage.html （本轮取 §12.1 引言、§12.2.1 `Storage` IDL 与 setItem 抛错句、§12.3.1 "Expiring stored data" 与 "Treating persistent storage as cookies"）
- WHATWG Storage Standard — https://storage.spec.whatwg.org/ （本轮取 §4.1 registered storage endpoints 配额表、§4.6 storage bottle quota、§4.5 bucket mode、§5 Persistence permission、§6 Usage and quota、§7.1 Storage pressure、§7.2 UI guidelines、`StorageEstimate` 字典）
- MDN, `Window.localStorage` — https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage （Document last modified 2026-10-12）
- MDN, *Storage quotas and eviction criteria* — https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria （last modified 2026-01-05）
- MDN, `StorageManager: persist()` — https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist （last modified 2026-10-12）
- MDN, `StorageManager: estimate()` — https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/estimate （last modified 2026-10-12）
- MDN, *IndexedDB key characteristics and basic terminology* — https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology （last modified 2026-09-04；由旧 URL `…/IndexedDB_API/Basic_Concepts_Behind_IndexedDB` 重定向取得）
- MDN, *Using the Web Storage API* — https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API/Using_the_Web_Storage_API （last modified 2026-05-26）
- MDN, `Storage: setItem()` — https://developer.mozilla.org/en-US/docs/Web/API/Storage/setItem （last modified 2025-08-19；仅用于 `QuotaExceededError` 措辞）
- WebKit Blog, *Updates to Storage Policy*（Sihui Liu, Aug 10, 2023）— https://webkit.org/blog/14403/updates-to-storage-policy/
- WebKit, *Tracking Prevention in WebKit*（政策页）— https://webkit.org/tracking-prevention/
- WebKit Blog, *Full Third-Party Cookie Blocking and More*（John Wilander, Mar 24, 2020）— https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- Chromium 官方设计文档, *Chrome Web Storage and Quota Concepts*（jsbell@chromium.org, ayui@chromium.org；正文标注 "Last Updated: Oct 11, 2024"；MDN 配额篇 "See also" 亦指向此文）— https://docs.google.com/document/d/19QemRTdIxYaJ4gkHYf2WWBNPbpuZQDNMpUVf8dQxj4U/edit
- 本地仓库现状（非 web 来源，用于 §5）：`C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/src/panel/manual-order.ts`

### 非一手（Google/Chrome 团队官方文档站，但文中自认含未查证项，不作为唯一依据）

- web.dev, *Storage for the web*（Last updated 2024-09-23）— https://web.dev/articles/storage-for-the-web 。本轮采信其「localStorage 同步、阻塞主线程、worker 不可用、estimate 只报 IndexedDB+Cache」与 Chrome 配额/驱逐段；**不采信**其 Safari 段（原文自陈 "I was unable to find any official documentation on this"，且被 WebKit 2023 blog 的 60%/15% 取代）与 Firefox 2GB 段（与 MDN 冲突）。
- web.dev, *Persistent storage*（Last updated 2020-05-12）— https://web.dev/articles/persistent-storage 。用于 Chrome/WebKit 的 persist() 授权启发式与受保护类型清单；页面更新日期为 2020 年，属偏旧文档。
- 二者对 incognito 配额的说法互斥（约 5% 磁盘 vs min(10% 内存, 300MB)），本轮以 Chromium 设计文档为准。

### 传输通道说明

- 阅读日期 **2026-11-17**。
- `developer.mozilla.org`、`webkit.org`、`html.spec.whatwg.org`、`storage.spec.whatwg.org` **经直连取得**（未设代理）。
- Google 域（`web.dev`、`docs.google.com`）直连 WebFetch 失败（`fetch failed`），改为 `export HTTPS_PROXY=http://localhost:7890` + `curl -L` 取回；Google Doc 用 `/export?format=txt` 端点取纯文本，HTTP 200、19,303 B，正文含 "Last Updated: Oct 11, 2024" 与作者行。
- web.dev 两篇同样经代理 `curl` 取 HTML，再用本地 Node 剥标签转文本后阅读，引文取自该文本视图；HTML 原文中实体（`&#39;`、`&amp;`）已还原，故引文中的撇号/与号是页面渲染后的形态。
- `searchfox.org` 的 `…/raw-file/…` 端点 404（试过 `dom/storage/StorageManager.cpp`、`dom/webStorage/StorageManager.cpp`、`default` 与 `main` 两种 ref），故 Firefox 侧源码级数值未取得，列为「待核实」第 5 条。
- `https://developer.chrome.com/docs/capabilities/storage-quotas` 与 `…/web-apis/persistent-storage` 均返回 404，未采信用途；MDN 配额篇 "See also" 指向的 `https://developer.chrome.com/docs/capabilities/storage-quotas` 已失效，本文不引用。
- 全文未使用任何第三方博客、Stack Overflow、榜单或摘要站。

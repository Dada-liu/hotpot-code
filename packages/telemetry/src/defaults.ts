// 默认遥测地址：指向已部署的 telemetry server，安装后即可匿名上报。
// 运行时优先使用用户 settings 的 telemetry.endpoint 或 HOTPOT_TELEMETRY_ENDPOINT；
// 显式把环境变量置空（HOTPOT_TELEMETRY_ENDPOINT=""）可整体关闭遥测。
export const DEFAULT_TELEMETRY_ENDPOINT = "http://124.221.211.237:8080/";

// 与 package.json 的 version 保持一致；运行时可通过 createTelemetryClient 的 appVersion 覆盖。
export const APP_VERSION = "0.1.1";

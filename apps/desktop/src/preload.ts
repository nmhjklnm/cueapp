import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("cueapp", {
  version: "0.0.0",
});

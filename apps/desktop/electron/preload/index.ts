import { contextBridge, ipcRenderer } from 'electron';
import { buildApi, type IpcLike } from './api.js';

contextBridge.exposeInMainWorld('sparkii', buildApi(ipcRenderer as unknown as IpcLike));

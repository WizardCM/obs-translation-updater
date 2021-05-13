import { resolve } from 'path';

export const projectId: number = 51028;
export const rootDir = resolve('.');
export const tempDir = resolve(rootDir, 'obs-translation-updater');

export const submodules = ['enc-amf', 'obs-browser', 'obs-vst'];

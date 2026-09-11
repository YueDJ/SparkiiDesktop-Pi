export function sha256File(path: string): Promise<string>;
export function readExpectedArchiveHash(checksumsPath: string): string;
export function verifyArchiveChecksum(archivePath: string, checksumsPath: string): Promise<string>;

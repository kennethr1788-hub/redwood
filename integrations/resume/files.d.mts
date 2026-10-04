export function containedFile(root: string, relative: string, missing?: boolean): Promise<string>;
export function readBounded(root: string, relative: string, max?: number): Promise<Buffer>;
export function writeDerived(root: string, relative: string, content: string): Promise<void>;

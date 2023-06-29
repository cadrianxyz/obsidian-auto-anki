import { safeStorage } from 'electron';

export function electronEncrypt(text: string) {
    if (safeStorage == undefined || safeStorage == null) {
        console.error('Could not encrypt string: safeStorage not available!')
        return text;
    }

    if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.encryptString(text);
    }
    else {
        console.error('Could not encrypt string: encryption not available!')
        throw Error('Could not encrypt string: encryption not available!');
    }
}

export function electronDecrypt(buf: Buffer) {
    if (safeStorage == undefined || safeStorage == null) {
        console.error('Could not decrypt string: safeStorage not available!')
        return buf;
    }

    if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(buf));
    }
    else {
        console.error('Could not decrypt string: encryption not available!')
        throw Error('Could not decrypt string: encryption not available!');
    }
}
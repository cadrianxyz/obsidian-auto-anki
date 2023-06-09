import { safeStorage } from 'electron';

export function electronEncrypt(text: string) {
    if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.encryptString(text);
    }
    else {
        console.error('Could not encrypt string: encryption not available!')
        throw Error('Could not encrypt string: encryption not available!');
    }
}

export function electronDecrypt(buf: Buffer) {

    if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(buf));
    }
    else {
        console.error('Could not decrypt string: encryption not available!')
        throw Error('Could not decrypt string: encryption not available!');
    }
}
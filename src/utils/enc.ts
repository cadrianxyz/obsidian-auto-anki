import { SafeStorage } from 'electron';
const electron = window.require("electron").remote;
const safeStorage = electron.safeStorage as SafeStorage

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
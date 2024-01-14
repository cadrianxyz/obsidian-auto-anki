// import fs from 'fs';
import { Notice } from 'obsidian';
import { createLogger, format, transports } from 'winston';
import Transport from 'winston-transport';

class ObsidianNoticeTransport extends Transport {
    constructor(opts?: Transport.TransportStreamOptions) {
        super(opts);
    }
  
    log(info: any, callback: () => void) {
        setImmediate(() => {
            this.emit('logged', info);
        });
    
        // Perform the writing to the remote service
        new Notice(`ERROR ("auto-anki" plugin)\n${info.message}`, 0)
        callback();
    }
}

const logger = createLogger({
    level: 'info',
    format: format.json(),
    transports: [
        // new transports.File({ filename: `${logDir}/error.log`, level: 'error' }),
        // new transports.File({ filename: `${logDir}/combined.log` })
    ]
});

logger.add(new ObsidianNoticeTransport({ level: 'error' }));

if (process.env.NODE_ENV !== 'production') {
    logger.add(new transports.Console({
        format: format.simple(),
    }));
}

export default logger;

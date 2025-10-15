import TelegramBot from 'node-telegram-bot-api';
import EventEmitter from 'events';

const driverBot = new TelegramBot(process.env.TELEGRAM_DRIVER_BOT_TOKEN, { polling: true });
const driverEvents = new EventEmitter();

export { driverBot, driverEvents };

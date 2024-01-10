import { Context, Logger, Schema } from 'koishi';
import { StockSession } from 'koishi-plugin-adapter-iirose';
import { Stock } from 'koishi-plugin-adapter-iirose/lib/decoder/Stock';

export const name = 'iirose-stock-monitor';

export interface Config { }

export const Config: Schema<Config> = Schema.object({});

export function apply(ctx: Context) {
  let nowData: Stock;

  const status = {
    down: 0,
    up: 0,
    baseMoney: 0,
    unitPrice: 0,
    lastBaseMoney: 1,
    has: 0,
    new: 0
  };

  // const logger = new Logger('IIROSE-Stock-Monitor');

  ctx.on('iirose/before-getUserList', () => {
    // logger.warn("接收全局大包...读取股票数据...");
    ctx.emit('iirose/stockGet', async (data: StockSession) => {
      if (!nowData)
      {
        nowData = data;
        status.baseMoney = data.personalMoney;
        status.unitPrice = 999999;
      }

      if (nowData == data)
      {
        return;
      }

      const message = [
        '\\\\\\*',
        '# 股价提醒'
      ];

      if (data.unitPrice == 1 && data.totalStock == 1000)
      {
        // 股票重置
        status.up = 0;
        status.down = 0;
        nowData = data;
        // logger.warn(`启动新股${(status.has > 0) ? "已损失" + status.has : ''}`);
        status.has = 0;
        status.new = 1;
        // console.log(status);
        nowData = data;

        message[2] = `股市崩盘！`;
        message[3] = `股价：${data.unitPrice}`;
        message[4] = `总股：${data.totalStock}`;
        message[5] = `总金：${data.totalMoney}`;

        return data.send({
          public: {
            message: message.join('\n')
          }
        });
      }

      if (data.unitPrice > nowData.unitPrice)
      {
        status.up++;
        status.down = 0;
        message[2] = `已增加${status.up}次`;
        message[3] = `已增加${(data.unitPrice - nowData.unitPrice).toFixed(2)} 增幅${(((data.unitPrice - nowData.unitPrice) / nowData.unitPrice) * 100).toFixed(2)}%`;
      }

      if (data.unitPrice < nowData.unitPrice)
      {
        status.up = 0;
        status.down++;
        message[2] = `已降低${status.down}次`;
        message[3] = `已降低${(nowData.unitPrice - data.unitPrice).toFixed(2)} 降幅${(((nowData.unitPrice - data.unitPrice) / nowData.unitPrice) * 100).toFixed(2)}%`;
      }

      // console.log(status);
      message[4] = `股价：${data.unitPrice}`;
      message[5] = `总股：${data.totalStock}`;
      message[6] = `总金：${data.totalMoney}`;

      nowData = data;

      return data.send({
        public: {
          message: message.join('\n')
        }
      });

      /*
      if (rate > 0.50) {
        data.bot.internal.stockSell(data.personalStock)
        return
      }
      */
    });
  });
}

import { Context, h, Logger, Schema } from 'koishi';
import { StockSession } from 'koishi-plugin-adapter-iirose';
import { Stock } from 'koishi-plugin-adapter-iirose/lib/decoder/Stock';
import { EchartsOption } from "koishi-plugin-puppeteer-echarts";

export const name = 'iirose-stock-monitor';

export interface BaseConfig {
  enableSuggestion: boolean
}

export interface EnabledConfig extends BaseConfig {
  enableSuggestion: true
  buyMoney?: [Number, Number, Boolean]
  sellMoney?: [Number, Number, Boolean]
  buyCombo?: [Number, Boolean]
  sellCombo?: [Number, Boolean]
}

export type Config = BaseConfig | EnabledConfig

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    enableSuggestion: Schema.boolean().default(false).description('是否开启建议'),
  }),
  Schema.union([
    Schema.object({
      enableSuggestion: Schema.const(true).required(),
      buyMoney: Schema.tuple([Number, Number, Boolean])
        .description('在价格在指定值之间的时候提示买进')
        .default([0.1, 0.2, false]),
      sellMoney: Schema.tuple([Number, Number, Boolean])
        .description('在价格在指定值之间的时候提示卖出')
        .default([1, 999, false,]),
      buyCombo: Schema.tuple([Number, Boolean])
        .description('在连续下跌指定值次的时候提示买进')
        .default([3, false]),
      sellCombo: Schema.tuple([Number, Boolean])
        .description('在连续上涨指定值次的时候提示卖出')
        .default([3, false]),
    }),
    Schema.object({
      enableSuggestion: Schema.const(false).required(),
    }),
  ]),
])

export const usage = ` # 须知
v0.0.7版本后，支持图表显示功能，但需要安装w-echarts插件及其依赖，若不习惯使用，请切换为v0.0.6版本
`;


export const inject = ['echarts'];

export function apply(ctx: Context)
{
  let tempData: Record<string, {
    nowData?: Stock;
    status: { down: number, up: number, baseMoney: number, unitPrice: number, lastBaseMoney: number, has: number, new: number; };
    isOpen: boolean;
    lastBuyPrice?: number;
    history: {
      price: number[];
      time: string[];
    };
  }> = {};

  let echartsOption: EchartsOption = {
    backgroundColor: 'rgba(254,248,239,1)', // 来自主题
    color: [
      "#d87c7c", "#919e8b", "#d7ab82", "#6e7074",
      "#61a0a8", "#efa18d", "#787464", "#cc7e63",
      "#724e58", "#4b565b"
    ],
    xAxis: {
      type: 'category',
      data: [],
      axisLine: {
        show: true,
        lineStyle: {
          color: '#333333'
        }
      },
      axisTick: {
        show: true,
        lineStyle: {
          color: '#333333'
        }
      },
      axisLabel: {
        show: true,
        color: '#333'
      },
      splitLine: {
        show: false
      }
    },
    yAxis: {
      type: 'value',
      axisLine: {
        show: true,
        lineStyle: {
          color: '#333'
        }
      },
      axisTick: {
        show: true,
        lineStyle: {
          color: '#333'
        }
      },
      axisLabel: {
        show: true,
        color: '#333'
      },
      splitLine: {
        show: true,
        lineStyle: {
          color: '#ccc'
        }
      }
    },
    series: [
      {
        data: [],
        type: 'line',
        lineStyle: {
          width: 2
        },
        symbol: 'emptyCircle',
        symbolSize: 8,
        itemStyle: {
          borderWidth: 2
        },
        smooth: false,
        label: {
          show: true,
          position: 'top'
        },
        markLine: {
          data: [{ type: 'average', name: 'Avg' }]
        }
      }
    ]
  };

  // const logger = new Logger('IIROSE-Stock-Monitor');

  ctx.command('iirose', '花园工具');

  ctx.command('iirose.stock.on', '开启股票监听功能')
    .alias('股票播报开启')
    .action(v =>
    {
      if (v.session.platform != "iirose") { return; }
      if (!tempData.hasOwnProperty(v.session.selfId))
      {
        tempData[v.session.selfId] = {
          status: {
            down: 0,
            up: 0,
            baseMoney: 0,
            unitPrice: 0,
            lastBaseMoney: 1,
            has: 0,
            new: 0
          },
          isOpen: true,
          history: {
            price: [],
            time: []
          }
        };
      }

      const thisBotObj = tempData[v.session.selfId];
      thisBotObj.isOpen = true;

      v.session.send(' [stockMonitor] 监听已开启');
    });

  ctx.command('iirose.stock.off', '关闭股票监听功能')
    .alias('股票播报关闭')
    .action(v =>
    {
      if (v.session.platform != "iirose") { return; }
      if (!tempData.hasOwnProperty(v.session.selfId))
      {
        tempData[v.session.selfId] = {
          status: {
            down: 0,
            up: 0,
            baseMoney: 0,
            unitPrice: 0,
            lastBaseMoney: 1,
            has: 0,
            new: 0
          },
          isOpen: false,
          history: {
            price: [],
            time: []
          }
        };
      }

      const thisBotObj = tempData[v.session.selfId];
      thisBotObj.isOpen = false;

      v.session.send(' [stockMonitor] 监听已关闭');
    });


  const getMiddleRange = (array: number[] | string[], minPercent: number, maxPercent: number) =>
  {
    const length = array.length;
    const start = Math.floor((minPercent / 100) * length);
    const end = Math.floor((maxPercent / 100) * length);
    return array.slice(start, end);
  };

  ctx.command('iirose.stock.chart', '查看本轮股票的图表')
    .alias('股票图表')
    .option('max', '-m [max:number] 最大显示百上限', { fallback: 100 })
    .option('min', '-n [min:number] 显示百分比下限', { fallback: 0 })
    .usage('注意：-m和-n的参数是0~100的值，-m和-n可以不写')
    .example('iirose.stock.chart -m 100 -n 0')
    .action(async v =>
    {

      if (v.session.platform != "iirose") { return; }

      const thisBotObj = tempData[v.session.selfId];

      if (thisBotObj.history.time.length <= 0) { return ' [stockMonitor] 插件未记录股票数据'; }

      echartsOption.series[0].data = getMiddleRange(thisBotObj.history.price, v.options.min, v.options.max);
      (echartsOption.xAxis as EchartsOption).data = getMiddleRange(thisBotObj.history.time, v.options.min, v.options.max);

      const width = (echartsOption.series[0].data.length * 100 + 100) < 1000 ? 1000 : (echartsOption.series[0].data.length * 100 + 100);

      const chart = await ctx.echarts.createChart(width, 700, echartsOption as any);

      return ' [stockMonitor] 本轮股票票价\n\n' + chart;
    });


  ctx.on('iirose/before-getUserList', (session) =>
  {
    if (!tempData.hasOwnProperty(session.selfId))
    {
      tempData[session.selfId] = {
        status: {
          down: 0,
          up: 0,
          baseMoney: 0,
          unitPrice: 0,
          lastBaseMoney: 1,
          has: 0,
          new: 0
        },
        isOpen: true,
        history: {
          price: [],
          time: []
        }
      };
    }

    const thisBotObj = tempData[session.selfId];

    if (!thisBotObj.isOpen) { return; }

    const status = thisBotObj.status;

    // const nowData = thisBotObj.nowData

    session.bot.internal.stockGet(async (data: StockSession) =>
    {
      if (!thisBotObj.nowData)
      {
        thisBotObj.nowData = data;
        status.baseMoney = data.personalMoney;
        status.unitPrice = 999999;
        // console.log(nowData)
      }

      if (thisBotObj.nowData == data)
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
        thisBotObj.nowData = data;
        // logger.warn(`启动新股${(status.has > 0) ? "已损失" + status.has : ''}`);
        status.has = 0;
        status.new = 1;

        message[2] = `股市崩盘！`;
        message[3] = `股价：${data.unitPrice}`;
        message[4] = `总股：${data.totalStock}`;
        message[5] = `总金：${data.totalMoney}`;

        thisBotObj.history.price = [data.unitPrice];
        const now = new Date();
        thisBotObj.history.time = [`${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`];

        return data.send({
          public: {
            message: message.join('\n')
          }
        });

      }

      thisBotObj.history.price.push(data.unitPrice);
      const now = new Date();
      thisBotObj.history.time.push(`${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`);

      if (data.unitPrice > thisBotObj.nowData.unitPrice)
      {
        status.up++;
        status.down = 0;
        message[2] = `已增加${status.up}次`;
        message[3] = `已增加${(data.unitPrice - thisBotObj.nowData.unitPrice).toFixed(3)} 增幅${(((data.unitPrice - thisBotObj.nowData.unitPrice) / thisBotObj.nowData.unitPrice) * 100).toFixed(2)}%`;
      }

      if (data.unitPrice < thisBotObj.nowData.unitPrice)
      {
        status.up = 0;
        status.down++;
        message[2] = `已降低${status.down}次`;
        message[3] = `已降低${(thisBotObj.nowData.unitPrice - data.unitPrice).toFixed(2)} 降幅${(((thisBotObj.nowData.unitPrice - data.unitPrice) / thisBotObj.nowData.unitPrice) * 100).toFixed(2)}%`;
      }

      // console.log(status);
      message[4] = `股价：${data.unitPrice}`;
      message[5] = `总股：${data.totalStock}`;
      message[6] = `总金：${data.totalMoney}`;

      thisBotObj.nowData = data;

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
    // logger.warn("接收全局大包...读取股票数据...");
  });
}

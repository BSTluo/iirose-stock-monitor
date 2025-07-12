import { stat } from 'fs';
import { Context, h, Logger, Schema } from 'koishi';
import { StockSession } from 'koishi-plugin-adapter-iirose';
import { Stock } from 'koishi-plugin-adapter-iirose/lib/decoder/Stock';
import { EchartsOption } from "koishi-plugin-puppeteer-echarts";

export const name = 'iirose-stock-monitor';
export interface Config {
  enableOnStartUp?: boolean;
  enableSuggestion?: boolean;
  buyMoney?: [number, number, boolean];
  sellMoney?: [number, number, boolean];
  buyCombo?: [number, boolean];
  sellCombo?: [number, boolean];
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    enableOnStartUp: Schema.boolean().default(true).description('启用该插件时立刻启动记录'),
  }),
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
    Schema.object({}),
  ]),
])

export const usage = ` # 须知
v0.0.7版本后，支持图表显示功能，但需要安装w-echarts插件及其依赖，若不习惯使用，请切换为v0.0.6版本
`;


export const inject = ['echarts'];

export function apply(ctx: Context)
{
  const config = ctx.config as Config;
  ctx.i18n.define('zh-CN', require('./locales/zh-CN.json'))
  ctx.i18n.define('en-US', require('./locales/en-US.json'))

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

      v.session.send(v.session.text('stockMonitor.enable'));
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

      v.session.send(v.session.text('stockMonitor.disable'));
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

      if (thisBotObj.history.time.length <= 0) { return v.session.text("stockMonitor.noData"); }

      echartsOption.series[0].data = getMiddleRange(thisBotObj.history.price, v.options.min, v.options.max);
      (echartsOption.xAxis as EchartsOption).data = getMiddleRange(thisBotObj.history.time, v.options.min, v.options.max);

      const width = (echartsOption.series[0].data.length * 100 + 100) < 1000 ? 1000 : (echartsOption.series[0].data.length * 100 + 100);

      const chart = await ctx.echarts.createChart(width, 700, echartsOption as any);

      return v.session.text("stockMonitor.data") + chart;
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

    if (config.enableOnStartUp){thisBotObj.isOpen=true}
    else {thisBotObj.isOpen=false}

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

      if (thisBotObj.nowData == data){
        return;
      }

      if (thisBotObj.nowData.totalMoney == data.totalMoney){ //你这不是没更新吗（震怒
        return;
      }

      const message = [
        '\\\\\\*',
        session.text("stockMonitor.header")
      ];

      if (data.unitPrice == 1 && data.totalStock == 1000)
      {
        // 股票重置
        status.up = 0;
        status.down = 0;
        // logger.warn(`启动新股${(status.has > 0) ? "已损失" + status.has : ''}`);
        status.has = 0;
        status.new = 1;

        message.push(session.text('stockMonitor.crash'));
        message.push(session.text('stockMonitor.beforeCrash',[thisBotObj.nowData.totalStock]));

        thisBotObj.nowData = data;

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
        if (status.up == 1) {message.push(session.text('stockMonitor.upFirst'))}
        else {message.push(session.text('stockMonitor.upTime',[status.up]))}
        message.push(session.text('stockMonitor.upCash',[(data.unitPrice - thisBotObj.nowData.unitPrice).toFixed(4),(((data.unitPrice - thisBotObj.nowData.unitPrice) / thisBotObj.nowData.unitPrice) * 100).toFixed(2)]));
      }

      if (data.unitPrice < thisBotObj.nowData.unitPrice)
      {
        status.up = 0;
        status.down++;
        if (status.down == 1) {message.push(session.text('stockMonitor.downFirst'))}
        else {message.push(session.text('stockMonitor.downTime',[status.down]))}
        message.push(session.text('stockMonitor.downCash',[(thisBotObj.nowData.unitPrice - data.unitPrice).toFixed(4),(((thisBotObj.nowData.unitPrice - data.unitPrice) / thisBotObj.nowData.unitPrice) * 100).toFixed(2)]));
      }

      // console.log(status);
      message.push(session.text("stockMonitor.unitPrice",[data.unitPrice,
        (data.unitPrice > thisBotObj.nowData.unitPrice)?`+${(data.unitPrice - thisBotObj.nowData.unitPrice).toFixed(4)}`:`-${(thisBotObj.nowData.unitPrice - data.unitPrice).toFixed(4)}`,
        (data.unitPrice > thisBotObj.nowData.unitPrice)?`+${(((data.unitPrice - thisBotObj.nowData.unitPrice) / thisBotObj.nowData.unitPrice) * 100).toFixed(2)}`:`-${(((thisBotObj.nowData.unitPrice - data.unitPrice) / thisBotObj.nowData.unitPrice) * 100).toFixed(2)}`
      ]));
      message.push(session.text("stockMonitor.totalStock",[data.totalStock,
        (data.totalStock > thisBotObj.nowData.totalStock)?`+${(data.totalStock - thisBotObj.nowData.totalStock).toFixed(0)}`:`-${(thisBotObj.nowData.totalStock - data.totalStock).toFixed(0)}`,
        (data.totalStock > thisBotObj.nowData.totalStock)?`+${(((data.totalStock - thisBotObj.nowData.totalStock) / thisBotObj.nowData.totalStock) * 100).toFixed(2)}`:`-${(((thisBotObj.nowData.totalStock - data.totalStock) / thisBotObj.nowData.totalStock) * 100).toFixed(2)}`
      ]));
      message.push(session.text("stockMonitor.totalMoney",[data.totalMoney,
        (data.totalMoney > thisBotObj.nowData.totalMoney)?`+${(data.totalMoney - thisBotObj.nowData.totalMoney).toFixed(0)}`:`-${(thisBotObj.nowData.totalMoney - data.totalMoney).toFixed(0)}`,
        (data.totalMoney > thisBotObj.nowData.totalMoney)?`+${(((data.totalMoney - thisBotObj.nowData.totalMoney) / thisBotObj.nowData.totalMoney) * 100).toFixed(2)}`:`-${(((thisBotObj.nowData.totalMoney - data.totalMoney) / thisBotObj.nowData.totalMoney) * 100).toFixed(2)}`
      ]));

  if (config.enableSuggestion) {
    const buyMoneyRange = config.buyMoney; // [Number, Number, Boolean]
    const sellMoneyRange = config.sellMoney; // [Number, Number, Boolean]
    const buyComboSetting = config.buyCombo; // [Number, Boolean]
    const sellComboSetting = config.sellCombo; // [Number, Boolean]
    
    if (buyMoneyRange && buyMoneyRange[2] && 
        data.unitPrice >= buyMoneyRange[0] && 
        data.unitPrice <= buyMoneyRange[1] && 
        data.unitPrice >= 0.1) { //防止小于0.1还提示买的极端情况
        message.push(session.text("stockMonitor.buyMoney", [data.unitPrice,buyMoneyRange[0],buyMoneyRange[1]]));
    }
    
    if (sellMoneyRange && sellMoneyRange[2] && 
        data.unitPrice >= sellMoneyRange[0] && 
        data.unitPrice <= sellMoneyRange[1]) {
        message.push(session.text("stockMonitor.sellMoney", [data.unitPrice,sellMoneyRange[0],sellMoneyRange[1]]));
    }
    
    if (buyComboSetting && buyComboSetting[1] && 
        status.down >= buyComboSetting[0] && 
        data.unitPrice >= 0.1) { 
        message.push(session.text("stockMonitor.buyCombo", [status.down]));
    }
    
    if (sellComboSetting && sellComboSetting[1] && 
        status.up >= sellComboSetting[0]) {
        message.push(session.text("stockMonitor.sellCombo", [status.up]));
    }
  }
  

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

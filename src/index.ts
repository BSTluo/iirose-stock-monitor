import { Context, Schema, h, Universal, Bot } from 'koishi';
import { EchartsOption } from "koishi-plugin-puppeteer-echarts";

export const name = 'iirose-stock-monitor';

export const inject = {
  optional: ['echarts'],
  required: ['logger', 'i18n']
};

export const usage = `
---

# 须知
v0.1.x版本重写了部分功能的实现以适配iirose-adapter v0.9.x，若不习惯需将该插件退回到v0.0.x 并将iirose-adapter退回到v0.8.x

你可能也需要重新写一下本地化文件... 现在挪到 "commands.iirose.stock.messages" 里了

---

必须依赖：koishi-plugin-puppeteer-echarts
`;

// 股票数据接口
export interface StockData
{
  unitPrice: number;
  totalStock: number;
  personalStock: number;
  totalMoney: number;
  personalMoney: number;
}

// 扩展 Koishi 事件
declare module 'koishi' {
  interface Events
  {
    'iirose/stock-update'(data: StockData): void;
  }
}

// 插件配置接口
export interface Config
{
  botTable?: { botId: string; channelId: string; }[];
  enableSuggestion?: boolean;
  sendTextAfterCrash?: boolean;
  sendChartAfterCrash?: boolean;
  enableTotalMoney?: boolean;
  buyStrategies?: number[];
  sellStrategies?: number[];
  buyComboStrategies?: number;
  sellComboStrategies?: number;
}

// 插件配置 Schema
export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    botTable: Schema.array(Schema.object({
      botId: Schema.string().description('机器人 ID'),
      channelId: Schema.string().description('频道 ID'),
    })).role('table').default([{ botId: "", channelId: "" }]).description("推送列表<br>填入`机器人ID`和对应的`频道ID`<br>推荐使用`inspect`指令查看信息后 填入此配置项"),
  }).description("推送列表"),

  Schema.object({
    enableSuggestion: Schema.boolean().default(true).description('推送`买进/卖出`建议。<br>即下方的`推荐策略`配置项。'),
    sendTextAfterCrash: Schema.boolean().default(true).description('在股票崩盘后 推送文字播报'),
    sendChartAfterCrash: Schema.boolean().default(true).description('在股票崩盘后 推送股票图'),
    enableTotalMoney: Schema.boolean().default(true).description('推送报表时，显示总金'),
  }).description("文字播报设定"),
  Schema.union([
    Schema.object({
      enableSuggestion: Schema.const(true),
      buyStrategies: Schema.tuple([Schema.number().default(0.1), Schema.number().default(0.2)]).description('价格区间买入推荐策略 (下限/上限)'),
      sellStrategies: Schema.tuple([Schema.number().default(1), Schema.number().default(999)]).description('价格区间卖出推荐策略 (下限/上限)'),
      buyComboStrategies: Schema.number().default(3).description('连续下跌买入推荐策略 (次数)'),
      sellComboStrategies: Schema.number().default(3).description('连续上涨买入推荐策略 (次数)'),
    }).description("推荐策略"),
    Schema.object({
      enableSuggestion: Schema.const(false).required(),
    }),
  ])
]);

export function apply(ctx: Context, config: Config)
{
  const logger = ctx.logger('iirose-stock-monitor');
  ctx.i18n.define("zh-CN", {
    commands: {
      "iirose.stock": {
        arguments: {
        },
        description: "iirose 股价监视",
        "messages": {
          "stockon": "[stockMonitor] 监听已开启",
          "stockoff": "[stockMonitor] 监听已关闭",
          "down": "在 {0} 秒内发送想要处理的图片",
          "cleaned": "[stockMonitor] 股票数据已清除",
          "noHistory": "[stockMonitor] 插件未记录股票数据",
          "chartHeader": "[stockMonitor] 本轮股票票价\n\n",
          "botOffline": "机器人 {0} 离线或未找到。",
          "sendFailed": "发送消息到频道 {0} 失败:",
          "reportTitle": "\\\\\\*# 股价提醒",
          "crashed": "股市崩盘了！",
          "crashInfo": "崩盘前盘内共有：{0}股",
          "rising": "开始增加",
          "riseCount": "已增加 {0} 次",
          "riseDetails": "已增加 {0} 钞; 增幅 {1}%",
          "falling": "开始降低",
          "fallCount": "已降低 {0} 次",
          "fallDetails": "已降低 {0} 钞; 降幅 {1}%",
          "unbuyable": " ! 不可购买 !",
          "priceReport": "股价：{0} ({1}，{2}){3}",
          "volumeReport": "总股：{0} ({1}，{2})",
          "moneyReport": "总金：{0} ({1}，{2})",
          "buySuggestionRange": "建议买入：当前股价 {0} 钞，在配置区间[{1}~{2}]内",
          "sellSuggestionRange": "建议卖出：当前股价 {0} 钞，在配置区间[{1}~{2}]内",
          "buySuggestionCombo": "建议买入：股价已连续下跌 {0} 次",
          "sellSuggestionCombo": "建议卖出：股价已连续上涨 {0} 次",
        },
        options: {
        }
      },
    },
  });
  ctx.i18n.define("en-US", {
    commands: {
      "iirose.stock": {
        arguments: {
        },
        description: "IIRose Stock Price Monitor",
        "messages": {
          "stockon": "[stockMonitor] Monitoring enabled.",
          "stockoff": "[stockMonitor] Monitoring disabled.",
          "down": "Please send the image to be processed within {0} seconds.",
          "cleaned": "[stockMonitor] Stock data has been cleared.",
          "noHistory": "[stockMonitor] No stock data recorded by the plugin.",
          "chartHeader": "[stockMonitor] Stock Price Chart for this round\n\n",
          "botOffline": "Bot {0} is offline or not found.",
          "sendFailed": "Failed to send message to channel {0}:",
          "reportTitle": "\\\\\\*# Stock Price Alert",
          "crashed": "The stock market has crashed!",
          "crashInfo": "Total shares before crash: {0}",
          "rising": "Price started to rise.",
          "riseCount": "Price has risen {0} times.",
          "riseDetails": "Increased by {0} credits; Rise of {1}%",
          "falling": "Price started to fall.",
          "fallCount": "Price has fallen {0} times.",
          "fallDetails": "Decreased by {0} credits; Fall of {1}%",
          "unbuyable": " ! Not buyable !",
          "priceReport": "Price: {0} ({1}, {2}){3}",
          "volumeReport": "Total Volume: {0} ({1}, {2})",
          "moneyReport": "Total Money: {0} ({1}, {2})",
          "buySuggestionRange": "Suggestion: Buy. Current price {0} is within the configured range [{1}~{2}].",
          "sellSuggestionRange": "Suggestion: Sell. Current price {0} is within the configured range [{1}~{2}].",
          "buySuggestionCombo": "Suggestion: Buy. Price has fallen consecutively for {0} times.",
          "sellSuggestionCombo": "Suggestion: Sell. Price has risen consecutively for {0} times.",
        },
        options: {
        }
      },
    }
  });

  // i18n 快捷调用
  const t = (path: string, params: object = {}) => [].concat(ctx.i18n.render(ctx.i18n.fallback([]), [`commands.iirose.stock.messages.${path}`], params)).join('');

  // 插件内部状态，用于跟踪股票数据
  let stockState = {
    nowData: null as StockData,
    status: { down: 0, up: 0 },
    isOpen: true, // 监听器默认开启
    history: {
      price: [] as number[],
      time: [] as string[],
    },
  };

  /**
   * 格式化数字变化，自动添加正负号和单位。
   * @param value - 数值
   * @param precision - 小数精度
   * @param unit - 单位 (可选)
   * @returns 格式化后的字符串
   */
  function formatChange(value: number, precision: number, unit: string = ''): string
  {
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(precision)}${unit}`;
  }

  // 消息发送函数，会遍历配置表中的所有机器人和频道
  const sendMessage = async (content: string | h) =>
  {
    if (!config.botTable || config.botTable.length === 0) return;

    for (const botInfo of config.botTable)
    {
      if (!botInfo.botId || !botInfo.channelId) continue;

      const bot = ctx.bots.find(b => b.selfId === botInfo.botId || b.user?.id === botInfo.botId);
      if (!bot || bot.status !== Universal.Status.ONLINE)
      {
        logger.error(t('botOffline', { 0: botInfo.botId }));
        continue;
      }
      try
      {
        await bot.sendMessage(botInfo.channelId, content);
      } catch (error)
      {
        logger.error(t('sendFailed', { 0: botInfo.channelId }), error);
      }
    }
  };

  // #region 指令
  ctx.command('iirose.stock.on', '开启股票监听功能')
    .alias('股票播报开启')
    .action(() =>
    {
      stockState.isOpen = true;
      return t('stockon');
    });

  ctx.command('iirose.stock.off', '关闭股票监听功能')
    .alias('股票播报关闭')
    .action(() =>
    {
      stockState.isOpen = false;
      return t('stockoff');
    });

  ctx.command('iirose.stock.clean', '清除历史股票数据')
    .alias('清空股票数据')
    .action(() =>
    {
      stockState.history.price = [];
      stockState.history.time = [];
      stockState.nowData = null;
      return t('cleaned');
    });
  // #endregion

  const echartsOption: EchartsOption = {
    backgroundColor: 'rgba(254,248,239,1)',
    color: ["#d87c7c", "#919e8b", "#d7ab82", "#6e7074", "#61a0a8", "#efa18d", "#787464", "#cc7e63", "#724e58", "#4b565b"],
    xAxis: {
      type: 'category',
      data: [],
      axisLine: { show: true, lineStyle: { color: '#333333' } },
      axisTick: { show: true, lineStyle: { color: '#333333' } },
      axisLabel: { show: true, color: '#333' },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      axisLine: { show: true, lineStyle: { color: '#333' } },
      axisTick: { show: true, lineStyle: { color: '#333' } },
      axisLabel: { show: true, color: '#333' },
      splitLine: { show: true, lineStyle: { color: '#ccc' } }
    },
    series: [{
      data: [],
      type: 'line',
      lineStyle: { width: 2 },
      symbol: 'emptyCircle',
      symbolSize: 8,
      itemStyle: { borderWidth: 2 },
      smooth: false,
      label: { show: true, position: 'top' },
      markLine: { data: [{ type: 'average', name: 'Avg' }] }
    }]
  };

  const getMiddleRange = (array: any[], minPercent: number, maxPercent: number) =>
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
    .action(async ({ options }) =>
    {
      if (stockState.history.price.length <= 0)
      {
        return t('noHistory');
      }

      echartsOption.series[0].data = getMiddleRange(stockState.history.price, options.min, options.max);
      (echartsOption.xAxis as any).data = getMiddleRange(stockState.history.time, options.min, options.max);

      const width = (echartsOption.series[0].data.length * 100 + 100) < 1000 ? 1000 : (echartsOption.series[0].data.length * 100 + 100);
      const chart = await ctx.echarts.createChart(width, 700, echartsOption);

      return t('chartHeader') + chart;
    });

  ctx.on('iirose/stock-update', async (data) =>
  {
    if (!stockState.isOpen) return;

    const { nowData, status, history } = stockState;
    if (!nowData)
    {
      stockState.nowData = data;
      return;
    }
    if (nowData.totalMoney === data.totalMoney) return;

    const message: string[] = [t('reportTitle')];

    // 崩盘处理
    if (data.unitPrice === 1 && data.totalStock === 1000)
    {
      status.up = 0;
      status.down = 0;
      message.push(t('crashed'), t('crashInfo', { 0: nowData.totalStock }));

      if (config.sendTextAfterCrash) await sendMessage(message.join('\n'));

      // 发送图表
      if (config.sendChartAfterCrash && ctx.echarts)
      {
        const echartsOption: EchartsOption = {
          backgroundColor: 'rgba(254,248,239,1)',
          color: ["#d87c7c", "#919e8b", "#d7ab82", "#6e7074", "#61a0a8", "#efa18d", "#787464", "#cc7e63", "#724e58", "#4b565b"],
          xAxis: {
            type: 'category', data: history.price, axisLine: { show: true, lineStyle: { color: '#333333' } },
            axisTick: { show: true, lineStyle: { color: '#333333' } }, axisLabel: { show: true, color: '#333' }, splitLine: { show: false }
          },
          yAxis: {
            type: 'value', axisLine: { show: true, lineStyle: { color: '#333' } },
            axisTick: { show: true, lineStyle: { color: '#333' } }, axisLabel: { show: true, color: '#333' }, splitLine: { show: true, lineStyle: { color: '#ccc' } }
          },
          series: [{
            data: history.price, type: 'line', lineStyle: { width: 2 }, symbol: 'emptyCircle',
            symbolSize: 8, itemStyle: { borderWidth: 2 }, smooth: false,
            label: { show: true, position: 'top' }, markLine: { data: [{ type: 'average', name: 'Avg' }] }
          }]
        };
        const width = (history.price.length * 100 + 100) < 1000 ? 1000 : (history.price.length * 100 + 100);
        const chart = await ctx.echarts.createChart(width, 700, echartsOption);
        await sendMessage(chart);
      }

      stockState.nowData = data;
      const now = new Date();
      history.price = [data.unitPrice];
      history.time = [`${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`];
      return;
    }

    // 记录历史数据 (每 1.5 分钟一次)
    const now = new Date();
    const lastTime = history.time[history.time.length - 1];
    if ((!lastTime || (now.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(lastTime.split(':')[0]), parseInt(lastTime.split(':')[1])).getTime()) > 90000) && data.unitPrice !== nowData.unitPrice)
    {
      history.price.push(data.unitPrice);
      history.time.push(`${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`);
    }

    // #region 播报
    const priceChange = data.unitPrice - nowData.unitPrice;
    const priceChangePercent = (priceChange / nowData.unitPrice) * 100;

    // 涨跌趋势播报
    if (priceChange > 0)
    {
      status.up++;
      status.down = 0;
      const riseText = status.up === 1 ? t('rising') : t('riseCount', { 0: status.up });
      const riseDetailText = t('riseDetails', { 0: priceChange.toFixed(4), 1: priceChangePercent.toFixed(2) });
      message.push(riseText, riseDetailText);
    } else if (priceChange < 0)
    {
      status.down++;
      status.up = 0;
      const fallText = status.down === 1 ? t('falling') : t('fallCount', { 0: status.down });
      const fallDetailText = t('fallDetails', { 0: (-priceChange).toFixed(4), 1: (-priceChangePercent).toFixed(2) });
      message.push(fallText, fallDetailText);
    }

    // 核心数据播报
    const priceChangeFormatted = formatChange(priceChange, 4, '钞');
    const pricePercentFormatted = formatChange(priceChangePercent, 2, '%');
    const buyabilityInfo = data.unitPrice <= 0.1 ? t('unbuyable') : '';
    message.push(t('priceReport', { 0: data.unitPrice, 1: priceChangeFormatted, 2: pricePercentFormatted, 3: buyabilityInfo }));

    const volumeChange = data.totalStock - nowData.totalStock;
    const volumeChangePercent = (volumeChange / nowData.totalStock) * 100;
    const volumeChangeFormatted = formatChange(volumeChange, 0, '股');
    const volumePercentFormatted = formatChange(volumeChangePercent, 2, '%');
    message.push(t('volumeReport', { 0: data.totalStock, 1: volumeChangeFormatted, 2: volumePercentFormatted }));

    if (config.enableTotalMoney)
    {
      const moneyChange = data.totalMoney - nowData.totalMoney;
      const moneyChangePercent = (moneyChange / nowData.totalMoney) * 100;
      const moneyChangeFormatted = formatChange(moneyChange, 0, '钞');
      const moneyPercentFormatted = formatChange(moneyChangePercent, 2, '%');
      message.push(t('moneyReport', { 0: data.totalMoney, 1: moneyChangeFormatted, 2: moneyPercentFormatted }));
    }

    // 策略建议播报
    if (config.enableSuggestion)
    {
      const { buyStrategies, sellStrategies, buyComboStrategies, sellComboStrategies } = config;
      if (buyStrategies && data.unitPrice >= buyStrategies[0] && data.unitPrice <= buyStrategies[1] && data.unitPrice >= 0.1)
      {
        message.push(t('buySuggestionRange', { 0: data.unitPrice, 1: buyStrategies[0], 2: buyStrategies[1] }));
      }
      if (sellStrategies && data.unitPrice >= sellStrategies[0] && data.unitPrice <= sellStrategies[1])
      {
        message.push(t('sellSuggestionRange', { 0: data.unitPrice, 1: sellStrategies[0], 2: sellStrategies[1] }));
      }
      if (buyComboStrategies && status.down >= buyComboStrategies && data.unitPrice >= 0.1)
      {
        message.push(t('buySuggestionCombo', { 0: status.down }));
      }
      if (sellComboStrategies && status.up >= sellComboStrategies)
      {
        message.push(t('sellSuggestionCombo', { 0: status.up }));
      }
    }
    // #endregion

    stockState.nowData = data;

    // 检查是否配置了推送目标
    if (config.botTable && config.botTable.some(bot => bot.botId && bot.channelId))
    {
      await sendMessage(message.join('\n'));
    }
  });
}

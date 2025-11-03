import { Context, Schema, h, Universal, Bot } from 'koishi';
import { EchartsOption } from "koishi-plugin-puppeteer-echarts";

export const name = 'iirose-stock-monitor';

export const usage = `
---

# 须知
v0.0.7版本后，支持图表显示功能，若不习惯使用，请切换为v0.0.6版本

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

  Schema.object({
    buyStrategies: Schema.tuple([Schema.number().default(0.1), Schema.number().default(0.2)]).description('价格区间买入推荐策略 (下限/上限)'),
    sellStrategies: Schema.tuple([Schema.number().default(1), Schema.number().default(999)]).description('价格区间卖出推荐策略 (下限/上限)'),
    buyComboStrategies: Schema.number().default(3).description('连续下跌买入推荐策略 (次数)'),
    sellComboStrategies: Schema.number().default(3).description('连续上涨买入推荐策略 (次数)'),
  }).description("推荐策略"),
]);

export function apply(ctx: Context, config: Config)
{
  const logger = ctx.logger('iirose-stock-monitor');

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
        logger.error(`机器人 ${botInfo.botId} 离线或未找到。`);
        continue;
      }
      try
      {
        await bot.sendMessage(botInfo.channelId, content);
      } catch (error)
      {
        logger.error(`发送消息到频道 ${botInfo.channelId} 失败:`, error);
      }
    }
  };

  // #region 指令
  ctx.command('iirose.stock.on', '开启股票监听功能')
    .alias('股票播报开启')
    .action(() =>
    {
      stockState.isOpen = true;
      return '[stockMonitor] 监听已开启';
    });

  ctx.command('iirose.stock.off', '关闭股票监听功能')
    .alias('股票播报关闭')
    .action(() =>
    {
      stockState.isOpen = false;
      return '[stockMonitor] 监听已关闭';
    });

  ctx.command('iirose.stock.clean', '清除历史股票数据')
    .alias('清空股票数据')
    .action(() =>
    {
      stockState.history.price = [];
      stockState.history.time = [];
      stockState.nowData = null;
      return '[stockMonitor] 股票数据已清除';
    });
  // #endregion

  // 使用 ctx.inject 
  // 不然 dev模式会有前端卡死的问题
  ctx.inject(['echarts'], (ctx) =>
  {
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
          return '[stockMonitor] 插件未记录股票数据';
        }

        echartsOption.series[0].data = getMiddleRange(stockState.history.price, options.min, options.max);
        (echartsOption.xAxis as any).data = getMiddleRange(stockState.history.time, options.min, options.max);

        const width = (echartsOption.series[0].data.length * 100 + 100) < 1000 ? 1000 : (echartsOption.series[0].data.length * 100 + 100);
        const chart = await ctx.echarts.createChart(width, 700, echartsOption);

        return '[stockMonitor] 本轮股票票价\n\n' + chart;
      });
  });

  ctx.on('iirose/stock-update', async (data) =>
  {
    if (!stockState.isOpen) return;

    ctx.logger.info("开始处理股市数据...");

    const { nowData, status, history } = stockState;
    if (!nowData)
    {
      stockState.nowData = data;
      return;
    }
    if (nowData.totalMoney === data.totalMoney) return;

    const message: string[] = ['\\\\\\*', '# 股价提醒'];

    // 崩盘处理
    if (data.unitPrice === 1 && data.totalStock === 1000)
    {
      status.up = 0;
      status.down = 0;
      message.push('股市崩盘了！', `崩盘前盘内共有：${nowData.totalStock}股`);

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
      const riseText = status.up === 1 ? '开始增加' : `已增加 ${status.up} 次`;
      const riseDetailText = `已增加 ${priceChange.toFixed(4)} 钞; 增幅 ${priceChangePercent.toFixed(2)}%`;
      message.push(riseText, riseDetailText);
    } else if (priceChange < 0)
    {
      status.down++;
      status.up = 0;
      const fallText = status.down === 1 ? '开始降低' : `已降低 ${status.down} 次`;
      const fallDetailText = `已降低 ${(-priceChange).toFixed(4)} 钞; 降幅 ${(-priceChangePercent).toFixed(2)}%`;
      message.push(fallText, fallDetailText);
    }

    // 核心数据播报
    const priceChangeFormatted = formatChange(priceChange, 4, '钞');
    const pricePercentFormatted = formatChange(priceChangePercent, 2, '%');
    const buyabilityInfo = data.unitPrice <= 0.1 ? ' ! 不可购买 !' : '';
    message.push(`股价：${data.unitPrice} (${priceChangeFormatted}，${pricePercentFormatted})${buyabilityInfo}`);

    const volumeChange = data.totalStock - nowData.totalStock;
    const volumeChangePercent = (volumeChange / nowData.totalStock) * 100;
    const volumeChangeFormatted = formatChange(volumeChange, 0, '股');
    const volumePercentFormatted = formatChange(volumeChangePercent, 2, '%');
    message.push(`总股：${data.totalStock} (${volumeChangeFormatted}，${volumePercentFormatted})`);

    if (config.enableTotalMoney)
    {
      const moneyChange = data.totalMoney - nowData.totalMoney;
      const moneyChangePercent = (moneyChange / nowData.totalMoney) * 100;
      const moneyChangeFormatted = formatChange(moneyChange, 0, '钞');
      const moneyPercentFormatted = formatChange(moneyChangePercent, 2, '%');
      message.push(`总金：${data.totalMoney} (${moneyChangeFormatted}，${moneyPercentFormatted})`);
    }

    // 策略建议播报
    if (config.enableSuggestion)
    {
      const { buyStrategies, sellStrategies, buyComboStrategies, sellComboStrategies } = config;
      if (buyStrategies && data.unitPrice >= buyStrategies[0] && data.unitPrice <= buyStrategies[1] && data.unitPrice >= 0.1)
      {
        message.push(`建议买入：当前股价 ${data.unitPrice} 钞，在配置区间[${buyStrategies[0]}~${buyStrategies[1]}]内`);
      }
      if (sellStrategies && data.unitPrice >= sellStrategies[0] && data.unitPrice <= sellStrategies[1])
      {
        message.push(`建议卖出：当前股价 ${data.unitPrice} 钞，在配置区间[${sellStrategies[0]}~${sellStrategies[1]}]内`);
      }
      if (buyComboStrategies && status.down >= buyComboStrategies && data.unitPrice >= 0.1)
      {
        message.push(`建议买入：股价已连续下跌 ${status.down} 次`);
      }
      if (sellComboStrategies && status.up >= sellComboStrategies)
      {
        message.push(`建议卖出：股价已连续上涨 ${status.up} 次`);
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

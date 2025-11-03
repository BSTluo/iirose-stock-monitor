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
    })).role('table').default([{ botId: "", channelId: "" }]).description("推送列表<br>填入`机器人ID`和对应的`频道ID`"),
  }).description("推送列表"),

  Schema.object({
    enableSuggestion: Schema.boolean().default(false).description('推送`买进/卖出`建议'),
    sendTextAfterCrash: Schema.boolean().default(true).description('在股票崩盘后 推送文字播报'),
    sendChartAfterCrash: Schema.boolean().default(false).description('在股票崩盘后 推送股票图'),
    enableTotalMoney: Schema.boolean().default(true).description('推送报表时，显示总金'),
  }).description("文字播报设定"),

  Schema.object({
    buyStrategies: Schema.tuple([Schema.number().default(0.1), Schema.number().default(0.2)]).description('价格区间买入策略 (下限/上限)'),
    sellStrategies: Schema.tuple([Schema.number().default(1), Schema.number().default(999)]).description('价格区间卖出策略 (下限/上限)'),
    buyComboStrategies: Schema.number().default(3).description('连续下跌买入策略 (次数)'),
    sellComboStrategies: Schema.number().default(3).description('连续上涨买入策略 (次数)'),
  }).description("策略设定"),
]);

export function apply(ctx: Context, config: Config)
{
  const logger = ctx.logger('iirose-stock-monitor');

  // 插件内部状态
  let stockState = {
    nowData: null as StockData,
    status: { down: 0, up: 0 },
    isOpen: true, // 始终开启监听
    history: {
      price: [] as number[],
      time: [] as string[],
    },
  };

  // Echarts 图表基础配置
  const echartsOption: EchartsOption = {
    backgroundColor: 'rgba(254,248,239,1)',
    color: ["#d87c7c", "#919e8b", "#d7ab82", "#6e7074", "#61a0a8", "#efa18d", "#787464", "#cc7e63", "#724e58", "#4b565b"],
    xAxis: {
      type: 'category', data: [], axisLine: { show: true, lineStyle: { color: '#333333' } },
      axisTick: { show: true, lineStyle: { color: '#333333' } }, axisLabel: { show: true, color: '#333' }, splitLine: { show: false }
    },
    yAxis: {
      type: 'value', axisLine: { show: true, lineStyle: { color: '#333' } },
      axisTick: { show: true, lineStyle: { color: '#333' } }, axisLabel: { show: true, color: '#333' }, splitLine: { show: true, lineStyle: { color: '#ccc' } }
    },
    series: [{
      data: [], type: 'line', lineStyle: { width: 2 }, symbol: 'emptyCircle',
      symbolSize: 8, itemStyle: { borderWidth: 2 }, smooth: false,
      label: { show: true, position: 'top' }, markLine: { data: [{ type: 'average', name: 'Avg' }] }
    }]
  };

  // 消息发送函数，遍历 botTable
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

  // 指令定义
  ctx.command('iirose.stock.on', '开启股票监听功能').alias('股票播报开启')
    .action(() =>
    {
      stockState.isOpen = true;
      return '[stockMonitor] 监听已开启';
    });

  ctx.command('iirose.stock.off', '关闭股票监听功能').alias('股票播报关闭')
    .action(() =>
    {
      stockState.isOpen = false;
      return '[stockMonitor] 监听已关闭';
    });

  ctx.command('iirose.stock.clean', '清除历史股票数据').alias('清空股票数据')
    .action(() =>
    {
      stockState.history.price = [];
      stockState.history.time = [];
      stockState.nowData = null;
      return '[stockMonitor] 股票数据已清除';
    });

  const getMiddleRange = (array: any[], minPercent: number, maxPercent: number) =>
  {
    const length = array.length;
    const start = Math.floor((minPercent / 100) * length);
    const end = Math.floor((maxPercent / 100) * length);
    return array.slice(start, end);
  };

  // 使用 ctx.inject 使 echarts 相关的指令成为可选
  ctx.inject(['echarts'], (ctx) =>
  {
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

  // 核心事件监听器
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

    const message: string[] = ['\\\\\\*', '# 股价提醒'];

    // 崩盘处理
    if (data.unitPrice === 1 && data.totalStock === 1000)
    {
      status.up = 0;
      status.down = 0;
      message.push('股市崩盘了！', `崩盘前盘内共有：${nowData.totalStock}股`);

      if (config.sendTextAfterCrash) await sendMessage(message.join('\n'));

      // 条件化地发送图表
      if (config.sendChartAfterCrash && ctx.echarts)
      {
        echartsOption.series[0].data = getMiddleRange(history.price, 0, 100);
        (echartsOption.xAxis as any).data = getMiddleRange(history.time, 0, 100);
        const width = (echartsOption.series[0].data.length * 100 + 100) < 1000 ? 1000 : (echartsOption.series[0].data.length * 100 + 100);
        const chart = await ctx.echarts.createChart(width, 700, echartsOption);
        await sendMessage(chart);
      }

      stockState.nowData = data;
      const now = new Date();
      history.price = [data.unitPrice];
      history.time = [`${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`];
      return;
    }

    // 记录历史数据
    const now = new Date();
    const lastTime = history.time[history.time.length - 1];
    if ((!lastTime || (now.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(lastTime.split(':')[0]), parseInt(lastTime.split(':')[1])).getTime()) > 90000) && data.unitPrice !== nowData.unitPrice)
    {
      history.price.push(data.unitPrice);
      history.time.push(`${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`);
    }

    // 计算价格变化
    const priceChange = data.unitPrice - nowData.unitPrice;
    const priceChangePercent = (priceChange / nowData.unitPrice) * 100;

    if (priceChange > 0)
    {
      status.up++;
      status.down = 0;
      message.push(status.up === 1 ? '开始增加' : `已增加 ${status.up} 次`, `已增加 ${priceChange.toFixed(4)} 钞; 增幅 ${priceChangePercent.toFixed(2)}%`);
    } else if (priceChange < 0)
    {
      status.down++;
      status.up = 0;
      message.push(status.down === 1 ? '开始降低' : `已降低 ${status.down} 次`, `已降低 ${(-priceChange).toFixed(4)} 钞; 降幅 ${(-priceChangePercent).toFixed(2)}%`);
    }

    // 基础信息播报
    message.push(`股价：${data.unitPrice} (${priceChange > 0 ? `+${priceChange.toFixed(4)}` : priceChange.toFixed(4)}钞，${priceChangePercent > 0 ? `+${priceChangePercent.toFixed(2)}` : priceChangePercent.toFixed(2)}%)` + (data.unitPrice <= 0.1 ? ' ! 不可购买 !' : ''));
    const volumeChange = data.totalStock - nowData.totalStock;
    const volumeChangePercent = (volumeChange / nowData.totalStock) * 100;
    message.push(`总股：${data.totalStock} (${volumeChange > 0 ? `+${volumeChange.toFixed(0)}` : volumeChange.toFixed(0)}股，${volumeChangePercent > 0 ? `+${volumeChangePercent.toFixed(2)}` : volumeChangePercent.toFixed(2)}%)`);

    if (config.enableTotalMoney)
    {
      const moneyChange = data.totalMoney - nowData.totalMoney;
      const moneyChangePercent = (moneyChange / nowData.totalMoney) * 100;
      message.push(`总金：${data.totalMoney} (${moneyChange > 0 ? `+${moneyChange.toFixed(0)}` : moneyChange.toFixed(0)}钞，${moneyChangePercent > 0 ? `+${moneyChangePercent.toFixed(2)}` : moneyChangePercent.toFixed(2)}%)`);
    }

    // 策略建议
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

    stockState.nowData = data;

    // 检查是否需要发送消息
    if (config.botTable && config.botTable.some(bot => bot.botId && bot.channelId))
    {
      await sendMessage(message.join('\n'));
    }
  });

  // 插件卸载时清理
  ctx.on('dispose', () =>
  {
    // Clean up if needed
  });
}

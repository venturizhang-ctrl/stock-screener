/**
 * vpa.js — 量价分析交易模型 (Volume Price Analysis)
 *
 * 核心理念（Wyckoff/VPA）：
 * - 量是"努力"，价是"结果"
 * - 放量不涨 = 努力没结果 → 趋势可能反转（吸筹或出货）
 * - 缩量上涨 = 轻松上涨 → 供应被吸收，趋势健康
 * - 放量下跌 = 恐慌抛售 → 可能见底或加速下跌
 *
 * 阶段1：扫描A股涨幅榜，获取活跃股票（换手>2%, 剔除ST/新股/市值过小）
 * 阶段2：拉周K线（30根），运行量价分析
 * 阶段3：按综合评分排序输出
 */

(function() {

    updateMarketStatus();

    // ===== 可调参数 =====
    var minTurnover = 5;        // 日换手率下限（%）
    var minMarketCap = 40;      // 最低市值（亿）
    var changeMin = 0;          // 最低涨幅（0=不限制，抓到下跌的也有价值）

    var debugLines = [];
    function debugLog(msg) {
        console.log(msg);
        debugLines.push(msg);
        var el = document.getElementById('debugText');
        if (el) el.textContent = debugLines.join('\n');
    }

    // ===== 参数调整 =====
    (function() {
        var toOptions = [
            { id: 'optTo5', val: 5 },
            { id: 'optTo8', val: 8 },
            { id: 'optTo10', val: 10 },
            { id: 'optTo15', val: 15 }
        ];
        toOptions.forEach(function(opt) {
            var e = document.getElementById(opt.id);
            if (e) e.addEventListener('change', function() { if (this.checked) minTurnover = opt.val; });
        });

        var capOptions = [
            { id: 'optCap40', val: 40 },
            { id: 'optCap100', val: 100 },
            { id: 'optCap500', val: 500 }
        ];
        capOptions.forEach(function(opt) {
            var e = document.getElementById(opt.id);
            if (e) e.addEventListener('change', function() { if (this.checked) minMarketCap = opt.val; });
        });
    })();

    // ===== 新浪：全A股扫描（json_v2.php，纯JSON，按代码排序）=====
    // 返回字段: code, name, trade(现价), open, high, low,
    //   changepercent, volume, amount, turnoverratio, nmc, mktcap, symbol
    function fetchSinaPage(pageNum) {
        var url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
        var params = 'page=' + pageNum + '&num=100&sort=symbol&asc=1&node=hs_a&_s_r_a=page';
        return fetch(url + '?' + params).then(function(res) {
            if (!res.ok) throw new Error('Sina HTTP ' + res.status);
            return res.json();
        });
    }

    async function getActiveStocks(debugFn, minTo, minCap) {
        var stocks = [];
        var consecutiveEmpties = 0;
        var maxPages = 60; // 60页×100只=6000只，覆盖全A股

        for (var p = 1; p <= maxPages; p++) {
            var data = null;
            for (var retry = 0; retry < 3; retry++) {
                try {
                    data = await fetchSinaPage(p);
                    if (data && data.length > 0) break;
                    if (retry < 2) await delay(800);
                } catch (e) {
                    if (retry < 2) await delay(1000);
                }
            }

            if (!data || data.length === 0) {
                consecutiveEmpties++;
                if (consecutiveEmpties >= 3) {
                    if (debugFn) debugFn('连续3页空，停止。共扫' + (p-1) + '页');
                    break;
                }
                continue;
            }
            consecutiveEmpties = 0;

            for (var i = 0; i < data.length; i++) {
                var s = data[i];
                var code = s.code;
                var name = s.name;
                var turnover = parseFloat(s.turnoverratio) || 0;
                var nmcRaw = parseFloat(s.nmc) || 0;     // 万元
                var mktcapRaw = parseFloat(s.mktcap) || 0; // 万元
                var nmcYi = nmcRaw / 10000;   // 万元→亿
                var mktcapYi = mktcapRaw / 10000;

                // 过滤
                if (!code || !name) continue;
                if (turnover < minTo) continue;
                if (nmcYi < minCap) continue;
                // 跳过ST、新股、科创板、北交所
                if (name.indexOf('ST') >= 0 || name.indexOf('*ST') >= 0) continue;
                if (name.indexOf('N') === 0 || name.indexOf('C') === 0) continue;
                if (code.startsWith('688') || code.startsWith('8') || code.startsWith('4')) continue;

                stocks.push({
                    code: code,
                    name: name,
                    price: parseFloat(s.trade) || 0,
                    change: parseFloat(s.changepercent) || 0,
                    volume: parseFloat(s.volume) || 0,   // 股
                    turnover: turnover,
                    nmc: nmcYi,
                    mktcap: mktcapYi,
                    high: parseFloat(s.high) || 0,
                    low: parseFloat(s.low) || 0,
                    open: parseFloat(s.open) || 0,
                    symbol: (s.symbol || '').startsWith('sh') ? 1 : 0
                });
            }

            if (debugFn && p % 5 === 0) {
                debugFn('扫' + p + '页 候选' + stocks.length + '只');
            }

            await delay(200);
        }

        return stocks;
    }

    // ===== 新浪JSONP：周K线（30根）=====
    function fetchWeeklyKline(code) {
        return new Promise(function(resolve, reject) {
            var c = code.toString();
            var symbol = (c.startsWith('6') || c.startsWith('9') ? 'sh' : 'sz') + c;
            var cb = 'vw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

            var timer = setTimeout(function() {
                cleanup();
                reject(new Error('超时'));
            }, 10000);

            function cleanup() {
                clearTimeout(timer);
                delete window[cb];
                if (script && script.parentNode) script.parentNode.removeChild(script);
            }

            window[cb] = function(data) {
                cleanup();
                try {
                    if (!data || !Array.isArray(data)) { reject(new Error('无数据')); return; }
                    var bars = [];
                    for (var i = 0; i < data.length; i++) {
                        var bar = data[i];
                        var date = bar.day.split(' ')[0];
                        bars.push({
                            date: date,
                            open: parseFloat(bar.open) || 0,
                            close: parseFloat(bar.close) || 0,
                            high: parseFloat(bar.high) || 0,
                            low: parseFloat(bar.low) || 0,
                            volume: parseFloat(bar.volume) || 0
                        });
                    }
                    resolve(bars);
                } catch (e) { reject(e); }
            };

            var script = document.createElement('script');
            script.src = 'https://money.finance.sina.com.cn/quotes_service/api/jsonp_v2.php/' +
                cb + '/CN_MarketData.getKLineData?symbol=' + symbol +
                '&scale=1200&ma=no&datalen=35';
            script.onerror = function() { cleanup(); reject(new Error('网络错误')); };
            document.body.appendChild(script);
        });
    }

    // ===== 腾讯：获取流通市值（批量）=====
    function getTencentSymbol(code) {
        var c = code.toString();
        return (c.startsWith('6') || c.startsWith('9') ? 'sh' : 'sz') + c;
    }

    // ============================================================
    //  VPA 核心分析引擎
    // ============================================================

    /**
     * 计算周换手率
     * weeklyVolume: 周成交量(股)
     * floatShares: 流通股本(股)
     */
    function weekTurnover(weeklyVolume, floatShares) {
        if (!floatShares || floatShares <= 0) return 0;
        return weeklyVolume / floatShares * 100;
    }

    /**
     * 计算N周均线
     */
    function ma(bars, n, field) {
        field = field || 'close';
        if (bars.length < n) return null;
        var slice = bars.slice(-n);
        var sum = slice.reduce(function(a, b) { return a + (b[field] || 0); }, 0);
        return sum / n;
    }

    /**
     * 计算N周均量
     */
    function avgVol(bars, n, excludeLast) {
        var slice = bars.slice(-(n + (excludeLast || 0)), excludeLast ? -1 : undefined);
        if (excludeLast) slice = slice.slice(0, n);
        if (slice.length === 0) return 0;
        return slice.reduce(function(a, b) { return a + (b.volume || 0); }, 0) / slice.length;
    }

    /**
     * VPA 主分析函数
     * @param {Array} weeklyBars — 周K线（升序，最新在最后）
     * @param {Object} stockInfo  — {code, name, nmc, mktcap, price, turnover}
     * @returns {Object} 分析结果
     */
    function analyzeVPA(weeklyBars, stockInfo) {
        var result = {
            signal: '',           // 信号名称
            score: 0,             // 综合评分 (-5 ~ +5)
            trend: '',            // 趋势状态
            patterns: [],         // 检测到的模式
            metrics: {},          // 量化指标
            details: []           // 详细说明
        };

        var len = weeklyBars.length;
        if (len < 20) {
            result.signal = '数据不足';
            result.details.push('周K线不足20条');
            return result;
        }

        // ===== 基础计算 =====
        var lastIdx = len - 1;
        var cur = weeklyBars[lastIdx];       // 本周
        var prev1 = weeklyBars[lastIdx - 1]; // 上周
        var prev2 = weeklyBars[lastIdx - 2]; // 上上周
        var prev3 = weeklyBars[lastIdx - 3];
        var prev4 = weeklyBars[lastIdx - 4];

        // 周涨跌幅
        var curChg = (cur.close - prev1.close) / prev1.close * 100;
        var prev1Chg = (prev1.close - prev2.close) / prev2.close * 100;
        var prev2Chg = (prev2.close - prev3.close) / prev3.close * 100;
        var prev3Chg = prev3.close > 0 && prev4 ? (prev3.close - prev4.close) / prev4.close * 100 : 0;

        // 周振幅
        var curRange = (cur.high - cur.low) / cur.low * 100;
        var prev1Range = (prev1.high - prev1.low) / prev1.low * 100;

        // 收盘在周K线中的位置（0=最低, 1=最高）
        var curClosePos = cur.high > cur.low ? (cur.close - cur.low) / (cur.high - cur.low) : 0.5;
        var prev1ClosePos = prev1.high > prev1.low ? (prev1.close - prev1.low) / (prev1.high - prev1.low) : 0.5;

        // 均线
        var ma10 = ma(weeklyBars, 10, 'close');
        var ma20 = ma(weeklyBars, 20, 'close');
        var ma60 = len >= 60 ? ma(weeklyBars, 60, 'close') : ma(weeklyBars, Math.min(len, 60), 'close');

        // 均量
        var avgVol10 = avgVol(weeklyBars, 10, 1);  // 不含本周
        var avgVol20 = avgVol(weeklyBars, 20, 1);

        // 量比
        var curVolRatio = avgVol10 > 0 ? cur.volume / avgVol10 : 1;
        var prev1VolRatio = avgVol10 > 0 ? prev1.volume / avgVol10 : 1;

        // 周换手率（用流通市值估算流通股本）
        var floatShares = 0;
        if (stockInfo.nmc > 0 && stockInfo.price > 0) {
            floatShares = stockInfo.nmc * 100000000 / stockInfo.price;
        }
        // 如果nmc不可用，尝试从日换手率和日成交量反推
        if (floatShares <= 0 && stockInfo.turnover > 0 && stockInfo.volume > 0) {
            floatShares = stockInfo.volume / (stockInfo.turnover / 100);
        }
        // 如果上面都不行，用总市值的60%估算流通股本
        if (floatShares <= 0 && stockInfo.mktcap > 0 && stockInfo.price > 0) {
            floatShares = stockInfo.mktcap * 0.6 * 100000000 / stockInfo.price;
        }

        var curWeekTO = weekTurnover(cur.volume, floatShares);
        var prev1WeekTO = weekTurnover(prev1.volume, floatShares);
        var prev2WeekTO = weekTurnover(prev2.volume, floatShares);
        var prev3WeekTO = weekTurnover(prev3.volume, floatShares);
        var prev4WeekTO = prev4 ? weekTurnover(prev4.volume, floatShares) : 0;

        // 近5周累计换手
        var sumWeekTO5 = curWeekTO + prev1WeekTO + prev2WeekTO + prev3WeekTO + prev4WeekTO;
        var sumWeekTO4 = prev1WeekTO + prev2WeekTO + prev3WeekTO + prev4WeekTO; // 不含本周

        // 60周高低点
        var bars60 = weeklyBars.slice(-Math.min(60, len));
        var high60 = Math.max.apply(null, bars60.map(function(b) { return b.high; }));
        var low60 = Math.min.apply(null, bars60.map(function(b) { return b.low; }));
        var pos60 = (cur.close - low60) / (high60 - low60); // 0~1, 在60周中的位置

        // 保存指标
        result.metrics = {
            curChg: curChg, curRange: curRange, curClosePos: curClosePos,
            curVolRatio: curVolRatio, curWeekTO: curWeekTO,
            prev1Chg: prev1Chg, prev1WeekTO: prev1WeekTO, prev1ClosePos: prev1ClosePos,
            sumWeekTO5: sumWeekTO5, sumWeekTO4: sumWeekTO4,
            ma10: ma10, ma20: ma20, ma60: ma60,
            pos60: pos60, low60: low60, high60: high60,
            floatShares: floatShares
        };

        // ===== 趋势判断 =====
        var trend = 'neutral';
        var trendScore = 0;
        if (ma10 && ma20 && ma60 && cur.close > ma10 && ma10 > ma20 && ma20 > ma60) {
            trend = '强势上升';
            trendScore = 2;
        } else if (ma20 && ma60 && cur.close > ma20 && ma20 > ma60) {
            trend = '上升趋势';
            trendScore = 1;
        } else if (ma20 && ma60 && cur.close < ma20 && ma20 < ma60) {
            trend = '下降趋势';
            trendScore = -1;
        } else if (ma10 && ma20 && ma60 && cur.close < ma10 && ma10 < ma20 && ma20 < ma60) {
            trend = '强势下降';
            trendScore = -2;
        }
        result.trend = trend;

        // ===== 模式检测 =====

        // ----- 吸筹 Accumulation -----
        // 条件：前4周累计换手>100%（筹码充分交换），前4周价格基本横盘（累计涨跌<8%），当前价在60周中低位置
        if (sumWeekTO4 > 100) {
            var chg4 = prev4 ? (prev1.close - prev4.open) / prev4.open * 100 : 0;
            if (Math.abs(chg4) < 8 && pos60 < 0.6 && curClosePos > 0.4 && curChg > -3) {
                result.patterns.push({
                    name: '吸筹区',
                    score: 3,
                    detail: '前4周换手' + sumWeekTO4.toFixed(0) + '%但仅波动' + Math.abs(chg4).toFixed(1) + '%，底部筹码充分换手'
                });
            }
        }

        // ----- 高换手+极小波动（Effort vs Result）-----
        // 条件：本周换手>30%，本周涨幅<3%（绝对值），收盘在K线上半部
        var absCurChg = Math.abs(curChg);
        if (curWeekTO > 30 && absCurChg < 3 && pos60 < 0.7) {
            result.patterns.push({
                name: '低位高换手微波动',
                score: 2,
                detail: '本周换手' + curWeekTO.toFixed(0) + '%但仅波动' + absCurChg.toFixed(1) + '%，主力在吸筹'
            });
        }

        // ----- 放量突破 Markup Start -----
        // 条件：本周放量(量比>1.5)，本周涨幅>5%，收盘在K线上半部，价在MA20之上
        if (curVolRatio > 1.5 && curChg > 5 && curClosePos > 0.6 && ma20 && cur.close > ma20) {
            var score = pos60 < 0.5 ? 3 : 2; // 低位突破给更高分
            result.patterns.push({
                name: pos60 < 0.5 ? '低位放量突破' : '放量突破',
                score: score,
                detail: '周量比' + curVolRatio.toFixed(1) + '，周涨' + curChg.toFixed(1) + '%，' +
                    (pos60 < 0.5 ? '低位启动信号强烈' : '趋势延续信号')
            });
        }

        // ----- 震仓 Spring (Wyckoff) -----
        // 条件：前两周有一周大跌(>5%)+放量，本周强力反弹收复大部分，本周收盘强势
        var panicWeek = null;
        if (prev1Chg < -5 && prev1WeekTO > 20) panicWeek = prev1;
        if (prev2Chg < -5 && prev2WeekTO > 20 && !panicWeek) panicWeek = prev2;

        if (panicWeek && curChg > 3 && curClosePos > 0.6 && cur.close > panicWeek.high * 0.8) {
            result.patterns.push({
                name: '震仓反弹 Spring',
                score: 3,
                detail: '恐慌周后强力反弹，收复恐慌周高点的80%以上，经典的震仓结束信号'
            });
        }

        // ----- 缩量上涨 -----
        // 条件：本周上涨>2%，但量比<0.8（缩量），收盘强势
        if (curChg > 2 && curVolRatio < 0.8 && curClosePos > 0.5) {
            result.patterns.push({
                name: '缩量上涨',
                score: 1,
                detail: '量比' + curVolRatio.toFixed(2) + '，供应被吸收，上涨轻松'
            });
        }

        // ----- 高位滞涨（出货）-----
        if (curWeekTO > 30 && absCurChg < 2 && pos60 > 0.75 && curClosePos < 0.5) {
            result.patterns.push({
                name: '⚠️ 高位滞涨',
                score: -3,
                detail: '高位换手' + curWeekTO.toFixed(0) + '%却涨不动，收盘偏弱，警惕出货'
            });
        }

        // ----- 持续放量不涨（Distribution）-----
        // 只有当本周也表现疲弱时才判定为出货；如果本周放量突破，则是吸筹确认
        if (sumWeekTO4 > 120 && Math.abs(prev1Chg + prev2Chg + prev3Chg) < 10 && pos60 > 0.6 && curChg < 3) {
            result.patterns.push({
                name: '⚠️ 持续换手滞涨',
                score: -2,
                detail: '近4周换手' + sumWeekTO4.toFixed(0) + '%，价格几乎不动，本周仍无起色——警惕出货'
            });
        }
        // 如果经历高换手横盘后本周放量突破，是吸筹确认（强烈看多）
        if (sumWeekTO4 > 100 && Math.abs(prev1Chg + prev2Chg + prev3Chg) < 10 && pos60 < 0.90 && curChg > 5 && curClosePos > 0.5) {
            result.patterns.push({
                name: '🟢 吸筹确认-突破',
                score: 3,
                detail: '前4周换手' + sumWeekTO4.toFixed(0) + '%横盘蓄力，本周放量涨' + curChg.toFixed(1) + '%突破，经典吸筹结束信号'
            });
        }

        // ----- 放量下跌 -----
        if (curChg < -5 && curVolRatio > 1.5) {
            result.patterns.push({
                name: '🔴 放量下跌',
                score: -2,
                detail: '周跌' + curChg.toFixed(1) + '%，量比' + curVolRatio.toFixed(1) + '，恐慌抛售未结束'
            });
        }

        // ----- 缩量下跌（无买盘）-----
        if (curChg < -3 && curVolRatio < 0.7 && trendScore < 0) {
            result.patterns.push({
                name: '缩量阴跌',
                score: -1,
                detail: '跌' + curChg.toFixed(1) + '%但缩量，没有承接盘，阴跌风险'
            });
        }

        // ----- 连续放量上涨（动量接力）-----
        if (curChg > 5 && prev1Chg > 3 && curWeekTO > 20 && prev1WeekTO > 15 &&
            curClosePos > 0.6 && prev1ClosePos > 0.5 && ma20 && cur.close > ma20) {
            result.patterns.push({
                name: '连续放量上攻',
                score: 2,
                detail: '连续2周放量上涨(' + prev1Chg.toFixed(1) + '%→' + curChg.toFixed(1) + '%)，接力推升'
            });
        }

        // ----- 近5周累计换手>250%且股价上涨>20% -----
        var chg5 = prev4 ? (cur.close - prev4.open) / prev4.open * 100 : 0;
        if (sumWeekTO5 > 250 && chg5 > 20) {
            result.patterns.push({
                name: '巨量换手推升',
                score: 1,
                detail: '5周换手' + sumWeekTO5.toFixed(0) + '%推动涨' + chg5.toFixed(1) + '%，游资接力模式，注意追高风险'
            });
        }

        // ===== 综合评分 =====
        var patternScore = 0;
        result.patterns.forEach(function(p) { patternScore += p.score; });

        // 趋势修正
        var adjustedScore = patternScore;
        if (trendScore > 0) adjustedScore += 0.5; // 上升趋势加分
        if (trendScore < 0) adjustedScore -= 0.5; // 下降趋势减分
        if (trendScore >= 2 && patternScore > 0) adjustedScore += 0.5; // 强趋势+正面模式=double确认
        if (trendScore <= -2 && patternScore < 0) adjustedScore -= 0.5; // 强下降+负面=double确认

        // 60周位置修正
        if (pos60 < 0.3 && patternScore > 0) adjustedScore += 1; // 底部区域+正面=加分
        if (pos60 > 0.85 && patternScore > 0) adjustedScore -= 1; // 高位区域+正面=警惕

        // 限制分数范围
        adjustedScore = Math.max(-5, Math.min(5, adjustedScore));
        result.score = Math.round(adjustedScore * 10) / 10;

        // ===== 信号名称 =====
        if (result.score >= 3) result.signal = '🟢 强看多';
        else if (result.score >= 2) result.signal = '🟢 看多';
        else if (result.score >= 1) result.signal = '🟡 偏多';
        else if (result.score <= -3) result.signal = '🔴 强看空';
        else if (result.score <= -2) result.signal = '🔴 看空';
        else if (result.score <= -1) result.signal = '🟠 偏空';
        else result.signal = '⚪ 中性';

        // 生成摘要
        if (result.patterns.length > 0) {
            result.details = result.patterns.map(function(p) { return p.detail; });
        } else {
            result.details.push('本周无明显量价异常信号');
        }

        return result;
    }

    // ============================================================
    //  主流程
    // ============================================================

    document.getElementById('btnRefresh').addEventListener('click', runScreening);

    async function runScreening() {
        clearResults();
        hideError();
        setRefreshButton(true);
        debugLines = [];
        debugLog('=== 量价分析模型 VPA ===');
        debugLog('条件: 换手>' + minTurnover + '% + 市值>' + minMarketCap + '亿(剔除ST/新股/科创板/北交所)');
        debugLog('分析维度: 周K线量价关系 + 趋势位置 + 模式识别');
        debugLog('时间: ' + new Date().toLocaleTimeString());

        try {
            // ===== 阶段1：扫描活跃股票 =====
            showLoading('扫描活跃股...', '换手>' + minTurnover + '%');
            var candidates = await getActiveStocks(debugLog, minTurnover, minMarketCap);
            debugLog('阶段1: 活跃股票 ' + candidates.length + '只');

            if (candidates.length === 0) {
                debugLog('无符合条件的股票');
                showResults([]);
                finishRefresh();
                return;
            }

            // ===== 阶段2：拉周K线 + VPA分析 =====
            showLoading('拉周K线+VPA分析...', candidates.length + '只');
            var analyzedStocks = [];
            var processed = 0;
            var errors = 0;
            var batchSize = 3; // 周K线数据量大，降低并发

            for (var bi = 0; bi < candidates.length; bi += batchSize) {
                var batch = candidates.slice(bi, bi + batchSize);

                var promises = batch.map(function(stock) {
                    return fetchWeeklyKline(stock.code).then(function(bars) {
                        if (!bars || bars.length < 20) {
                            return { stock: stock, error: '周K线不足' };
                        }
                        // 运行VPA分析
                        var vpaResult = analyzeVPA(bars, {
                            code: stock.code,
                            name: stock.name,
                            nmc: stock.nmc,
                            mktcap: stock.mktcap,
                            price: stock.price,
                            turnover: stock.turnover,
                            volume: stock.volume
                        });
                        return { stock: stock, result: vpaResult, error: null };
                    }).catch(function(e) {
                        return { stock: stock, error: e.message };
                    });
                });

                var results = await Promise.all(promises);

                for (var ri = 0; ri < results.length; ri++) {
                    var r = results[ri];
                    if (r.error) {
                        errors++;
                    } else if (r.result && r.result.patterns.length > 0) {
                        // 只保留有信号的股票
                        analyzedStocks.push({
                            code: r.stock.code,
                            name: r.stock.name,
                            price: r.stock.price,
                            change: r.stock.change,
                            turnover: r.stock.turnover,
                            nmc: r.stock.nmc,
                            vpa: r.result
                        });
                    }
                    processed++;
                }

                var pct = Math.round(processed / candidates.length * 100);
                showLoading('VPA分析中...', processed + '/' + candidates.length +
                    ' (' + pct + '%) 信号' + analyzedStocks.length + '只');

                if (bi + batchSize < candidates.length) await delay(300);
            }

            // 按评分排序
            analyzedStocks.sort(function(a, b) {
                return Math.abs(b.vpa.score) - Math.abs(a.vpa.score) || b.vpa.score - a.vpa.score;
            });

            debugLog('=== 完成 ===');
            debugLog('扫描' + candidates.length + '只, 有信号' + analyzedStocks.length + '只, 失败' + errors);

            showResults(analyzedStocks);
            finishRefresh();

        } catch (e) {
            debugLog('!! ' + (e.message || e));
            showError(e.message || '分析失败');
            setRefreshButton(false);
            hideLoading();
        }
    }

    // ===== UI辅助 =====
    function clearResults() {
        var area = document.getElementById('resultArea');
        if (area) area.style.display = 'none';
        var list = document.getElementById('listResult');
        if (list) list.innerHTML = '';
        var count = document.getElementById('countResult');
        if (count) count.textContent = '0';
    }

    function showResults(stocks) {
        var area = document.getElementById('resultArea');
        if (area) area.style.display = 'block';
        var count = document.getElementById('countResult');
        if (count) count.textContent = stocks.length;
        renderStockList(stocks);
    }

    function renderStockList(stocks) {
        var list = document.getElementById('listResult');
        if (!list) return;
        list.innerHTML = '';

        if (stocks.length === 0) {
            list.innerHTML = '<div class="empty-state">📭 未发现量价异常信号<br><small>尝试降低换手率阈值</small></div>';
            return;
        }

        // 按类型分组：看多、看空、中性
        var bullish = stocks.filter(function(s) { return s.vpa.score >= 1; });
        var bearish = stocks.filter(function(s) { return s.vpa.score <= -1; });
        var neutral = stocks.filter(function(s) { return s.vpa.score > -1 && s.vpa.score < 1; });

        var html = '';

        if (bullish.length > 0) {
            html += '<div class="section-label">🟢 看多信号 (' + bullish.length + '只)</div>';
            html += renderTable(bullish);
        }
        if (neutral.length > 0) {
            html += '<div class="section-label" style="margin-top:16px;">⚪ 中性/弱信号 (' + neutral.length + '只)</div>';
            html += renderTable(neutral);
        }
        if (bearish.length > 0) {
            html += '<div class="section-label" style="margin-top:16px;">🔴 看空信号 (' + bearish.length + '只)</div>';
            html += renderTable(bearish);
        }

        list.innerHTML = html;

        // 点击展开详情
        list.querySelectorAll('.vpa-row').forEach(function(row) {
            row.addEventListener('click', function() {
                var detail = this.nextElementSibling;
                if (detail && detail.classList.contains('vpa-detail')) {
                    detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
                }
            });
        });
    }

    function renderTable(stocks) {
        var h = '<table class="result-table"><thead><tr>' +
            '<th>代码</th><th>名称</th><th>现价</th><th>涨跌</th><th>换手</th><th>信号</th><th>评分</th><th>趋势</th>' +
            '</tr></thead><tbody>';

        stocks.forEach(function(s) {
            var v = s.vpa;
            var metrics = v.metrics;
            var chgClass = s.change >= 0 ? 'up' : 'down';
            var scoreClass = v.score >= 2 ? 'score-high' : (v.score <= -2 ? 'score-low' : '');
            var shortSignal = v.signal.replace('🟢 ','').replace('🔴 ','').replace('🟡 ','').replace('🟠 ','').replace('⚪ ','');

            h += '<tr class="vpa-row" style="cursor:pointer">' +
                '<td>' + s.code + '</td>' +
                '<td><b>' + s.name + '</b></td>' +
                '<td>' + s.price.toFixed(2) + '</td>' +
                '<td class="' + chgClass + '">' + (s.change >= 0 ? '+' : '') + s.change.toFixed(2) + '%</td>' +
                '<td>' + s.turnover.toFixed(1) + '%</td>' +
                '<td>' + v.signal + '</td>' +
                '<td class="' + scoreClass + '"><b>' + (v.score > 0 ? '+' : '') + v.score.toFixed(1) + '</b></td>' +
                '<td style="font-size:12px;color:#999">' + v.trend + '</td>' +
                '</tr>';

            // 详情行
            h += '<tr class="vpa-detail" style="display:none"><td colspan="8" style="padding:8px 12px;background:#111;font-size:12px;color:#aaa;line-height:1.6">';
            h += '<b>指标：</b>周涨' + (metrics.curChg > 0 ? '+' : '') + metrics.curChg.toFixed(2) + '%' +
                ' | 周换手' + metrics.curWeekTO.toFixed(1) + '%' +
                ' | 量比' + metrics.curVolRatio.toFixed(2) +
                ' | 收盘位置' + (metrics.curClosePos * 100).toFixed(0) + '%' +
                ' | 60周位置' + (metrics.pos60 * 100).toFixed(0) + '%<br>';
            h += '<b>均线：</b>MA10 ' + (metrics.ma10 ? metrics.ma10.toFixed(2) : '-') +
                ' | MA20 ' + (metrics.ma20 ? metrics.ma20.toFixed(2) : '-') +
                ' | MA60 ' + (metrics.ma60 ? metrics.ma60.toFixed(2) : '-') + '<br>';
            h += '<b>5周累计换手：</b>' + metrics.sumWeekTO5.toFixed(0) + '%<br>';
            h += '<b>信号详情：</b><br>';
            v.details.forEach(function(d) { h += '  · ' + d + '<br>'; });
            h += '</td></tr>';

        });

        h += '</tbody></table>';
        return h;
    }

    function showLoading(title, sub) {
        var loader = document.getElementById('loadingOverlay');
        if (!loader) return;
        loader.style.display = 'flex';
        var t = document.getElementById('loadingTitle');
        var s = document.getElementById('loadingSub');
        if (t) t.textContent = title || '';
        if (s) s.textContent = sub || '';
    }

    function hideLoading() {
        var loader = document.getElementById('loadingOverlay');
        if (loader) loader.style.display = 'none';
    }

    function setRefreshButton(loading) {
        var btn = document.getElementById('btnRefresh');
        if (btn) {
            btn.disabled = loading;
            btn.textContent = loading ? '⏳ 分析中...' : '🔍 开始扫描';
        }
    }

    function showError(msg) {
        var el = document.getElementById('errorMsg');
        if (!el) return;
        el.textContent = msg;
        el.style.display = 'block';
    }

    function hideError() {
        var el = document.getElementById('errorMsg');
        if (el) el.style.display = 'none';
    }

    function finishRefresh() {
        hideLoading();
        setRefreshButton(false);
        var now = new Date();
        var ts = now.getHours().toString().padStart(2,'0') + ':' +
            now.getMinutes().toString().padStart(2,'0') + ':' +
            now.getSeconds().toString().padStart(2,'0');
        var el = document.getElementById('lastRefresh');
        if (el) el.textContent = '🕐 ' + ts;
        updateMarketStatus();
    }

    function showResultSection(id, show) {
        var el = document.getElementById(id);
        if (el) el.style.display = show ? 'block' : 'none';
    }

    function updateResultCount(id, count) {
        var el = document.getElementById(id);
        if (el) el.textContent = count;
    }

})();

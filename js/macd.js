/**
 * macd.js — 半木夏 MACD底背离策略 A股适配版
 *
 * 核心逻辑：
 * 阶段1（海选）：今日涨幅≥1%，拉取250根日K线
 * 阶段2（背离检测）：MACD底背离 —— 价格新低但MACD柱更高
 * 阶段3（入场确认）：放量中阳线 + 收盘强势
 *
 * A股适配：
 * - 原版15分钟 → 日线级别（A股T+1）
 * - 原版顶底背离双向 → 仅用底背离做多（A股无做空）
 * - 增加RSI底背离辅助确认
 * - 三段→两段背离（A股波动较小）
 */

(function() {

    updateMarketStatus();

    // ===== 可调参数 =====
    var divergeMin = 2;          // 最少背离段数（2或3）
    var divergeLookback = 120;   // 背离扫描区间（根K线）
    var changeMin = 1.0;         // 今日涨幅下限
    var entryVolMin = 1.5;       // 入场放量倍数
    var closeStrongPct = 0.85;   // 收盘强势阈值

    var debugLines = [];
    function debugLog(msg) {
        console.log(msg);
        debugLines.push(msg);
        var el = document.getElementById('debugText');
        if (el) el.textContent = debugLines.join('\n');
    }

    // ===== 参数调整 =====
    (function() {
        var el = document.getElementById('optDiv2');
        if (el) el.addEventListener('change', function() { if (this.checked) divergeMin = 2; });
        el = document.getElementById('optDiv3');
        if (el) el.addEventListener('change', function() { if (this.checked) divergeMin = 3; });
        var chgOptions = [
            { id: 'optChg1', val: 1 },
            { id: 'optChg2', val: 2 },
            { id: 'optChg3', val: 3 },
            { id: 'optChg5', val: 5 }
        ];
        chgOptions.forEach(function(opt) {
            var e = document.getElementById(opt.id);
            if (e) e.addEventListener('change', function() { if (this.checked) changeMin = opt.val; });
        });
    })();

    // ===== EMA计算 =====
    function calcEMA(data, period) {
        if (data.length < period) return [];
        var result = [];
        var k = 2 / (period + 1);
        for (var i = 0; i < data.length; i++) {
            if (i < period - 1) {
                result.push(null);
            } else if (i === period - 1) {
                var sum = 0;
                for (var j = 0; j < period; j++) sum += data[j];
                result.push(sum / period);
            } else {
                result.push(data[i] * k + result[i - 1] * (1 - k));
            }
        }
        return result;
    }

    // ===== MACD完整计算 =====
    function calcMACD(bars, fast, slow, signal) {
        fast = fast || 12;
        slow = slow || 26;
        signal = signal || 9;

        var closes = bars.map(function(b) { return b.close; });
        var emaFast = calcEMA(closes, fast);
        var emaSlow = calcEMA(closes, slow);

        // MACD线
        var macdLine = [];
        for (var i = 0; i < bars.length; i++) {
            if (emaFast[i] !== null && emaSlow[i] !== null) {
                macdLine.push(emaFast[i] - emaSlow[i]);
            } else {
                macdLine.push(null);
            }
        }

        // 信号线（MACD的9日EMA）
        var firstValid = null;
        for (var j = 0; j < macdLine.length; j++) {
            if (macdLine[j] !== null) { firstValid = j; break; }
        }
        if (firstValid === null) firstValid = slow;

        var signalLine = [];
        var histogram = [];
        var sigEma = null;

        for (var k = 0; k < bars.length; k++) {
            if (k < firstValid || macdLine[k] === null) {
                signalLine.push(null);
                histogram.push(null);
            } else if (k === firstValid) {
                sigEma = macdLine[k];
                signalLine.push(sigEma);
                histogram.push(macdLine[k] - sigEma);
            } else {
                var ks = 2 / (signal + 1);
                sigEma = macdLine[k] * ks + sigEma * (1 - ks);
                signalLine.push(sigEma);
                histogram.push(macdLine[k] - sigEma);
            }
        }

        return {
            macdLine: macdLine,
            signalLine: signalLine,
            histogram: histogram
        };
    }

    // ===== RSI计算 =====
    function calcRSI(bars, period) {
        period = period || 14;
        if (bars.length < period + 1) return [];

        var rsi = [];
        for (var i = 0; i < bars.length; i++) {
            if (i < period) { rsi.push(null); continue; }

            var avgGain = 0, avgLoss = 0;
            for (var j = i - period + 1; j <= i; j++) {
                var diff = bars[j].close - bars[j - 1].close;
                if (diff > 0) avgGain += diff;
                else avgLoss += Math.abs(diff);
            }
            avgGain /= period;
            avgLoss /= period;

            if (avgLoss === 0) rsi.push(100);
            else rsi.push(100 - (100 / (1 + avgGain / avgLoss)));
        }
        return rsi;
    }

    // ===== 日K线（250根）=====
    function fetchDailyKline250(code) {
        return new Promise(function(resolve, reject) {
            var c = code.toString();
            var symbol = (c.startsWith('6') || c.startsWith('9') ? 'sh' : 'sz') + c;
            var cb = 'dmd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

            var timer = setTimeout(function() {
                cleanup();
                reject(new Error('超时'));
            }, 12000);

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
                '&scale=240&ma=no&datalen=250';
            script.onerror = function() { cleanup(); reject(new Error('网络错误')); };
            document.body.appendChild(script);
        });
    }

    // ===== 阶段2：MACD底背离检测（严格版）=====
    function detectMACDDivergence(dailyBars, opts) {
        opts = opts || {};
        var minSegments = opts.minSegments || 2;
        var lookback = opts.lookback || 120;

        var result = {
            found: false,
            segments: 0,
            divergencePoints: [],
            rsiConfirm: false,
            details: []
        };

        if (dailyBars.length < 100) {
            result.details.push('K线不足100条');
            return result;
        }

        var macd = calcMACD(dailyBars, 12, 26, 9);
        var hist = macd.histogram;
        var rsi = calcRSI(dailyBars, 14);
        var len = dailyBars.length;
        var startIdx = Math.max(0, len - lookback);

        // === 前置过滤①：必须处于中期下跌趋势 ===
        // 条件：最近60天内有明显下跌（高点回撤 ≥ 10%）
        var high60 = -Infinity, low60 = Infinity;
        for (var hi = len - 61; hi < len; hi++) {
            if (hi < 0) continue;
            if (dailyBars[hi].high > high60) high60 = dailyBars[hi].high;
            if (dailyBars[hi].low < low60) low60 = dailyBars[hi].low;
        }
        var drawdown60 = high60 > 0 ? (high60 - low60) / high60 * 100 : 0;
        if (drawdown60 < 8) {
            result.details.push('✗ 无下跌趋势: 60日回撤仅' + drawdown60.toFixed(1) + '% < 8%');
            return result;
        }

        // 确认低点在近期（最近30天内必有阶段最低点）
        var low30Idx = -1, low30Val = Infinity;
        for (var li = len - 31; li < len; li++) {
            if (li < 0) continue;
            if (dailyBars[li].low < low30Val) {
                low30Val = dailyBars[li].low;
                low30Idx = li;
            }
        }
        // 30日最低点必须在60日高点的回撤区间内（说明下跌是真的）
        var fromHigh = high60 > 0 ? (high60 - low30Val) / high60 * 100 : 0;
        if (fromHigh < 5) {
            result.details.push('✗ 跌幅不足: 从高点仅回撤' + fromHigh.toFixed(1) + '%');
            return result;
        }

        // === 找局部价格低点（7天窗口，更严格）===
        var priceLows = [];
        for (var i = startIdx + 4; i < len - 4; i++) {
            var bar = dailyBars[i];
            var isLow = true;
            for (var j = i - 4; j <= i + 4; j++) {
                if (j === i) continue;
                if (dailyBars[j].low <= bar.low) { isLow = false; break; }
            }
            if (isLow && hist[i] !== null && rsi[i] !== null) {
                priceLows.push({
                    idx: i,
                    date: bar.date,
                    priceLow: bar.low,
                    histVal: hist[i],
                    rsiVal: rsi[i],
                    volume: bar.volume
                });
            }
        }

        if (priceLows.length < minSegments) {
            result.details.push('价格低点不足: ' + priceLows.length + '个');
            return result;
        }

        // 取最近的低点（最多6个）
        var recentLows = priceLows.slice(-6);

        // === 检查背离：价格创新低，但MACD柱更高 ===
        var divergences = [];
        var lastPrice = null, lastHist = null;

        for (var d = 0; d < recentLows.length; d++) {
            var pt = recentLows[d];
            if (lastPrice === null) {
                lastPrice = pt.priceLow;
                lastHist = pt.histVal;
                continue;
            }

            if (pt.priceLow < lastPrice) {
                var priceDrop = (lastPrice - pt.priceLow) / lastPrice * 100;

                // 前置过滤②：价格跌幅必须 ≥ 3%（排除毛刺）
                if (priceDrop >= 3.0) {
                    // 前置过滤③：MACD柱必须有明显抬升（≥ 10%）
                    var histRise = lastHist !== 0 ? (pt.histVal - lastHist) / Math.abs(lastHist) * 100 : 0;
                    if (pt.histVal > lastHist && histRise >= 10) {
                        divergences.push({
                            priceIdx: pt.idx,
                            date: pt.date,
                            prevDate: recentLows[d - 1].date,
                            priceLow: pt.priceLow,
                            prevPriceLow: lastPrice,
                            priceDrop: priceDrop.toFixed(1),
                            histVal: pt.histVal.toFixed(4),
                            prevHistVal: lastHist.toFixed(4)
                        });
                        lastPrice = pt.priceLow;
                        lastHist = pt.histVal;
                    } else {
                        // MACD不背离，但仍更新价格基准
                        lastPrice = pt.priceLow;
                        // 不更新hist，保持之前更低的hist值
                    }
                }
                // 跌幅不够3%的忽略，也不更新基准
            } else if (pt.priceLow >= lastPrice) {
                // 价格没创新低，保持原基准
                if (pt.histVal > lastHist) lastHist = pt.histVal;
            }
        }

        if (divergences.length < minSegments - 1) {
            result.details.push('背离段不足: ' + divergences.length + ' < ' + (minSegments - 1));
            return result;
        }

        // === 前置过滤④：最近一个背离必须在15天内（信号新鲜）===
        var lastDiv = divergences[divergences.length - 1];
        var daysSince = len - 1 - lastDiv.priceIdx;
        if (daysSince > 20) {
            result.details.push('✗ 背离过期: 距今' + daysSince + '天 > 20天');
            return result;
        }

        // === 前置过滤⑤：RSI必须处于低位（< 45）===
        var rsiAtLastLow = rsi[lastDiv.priceIdx];
        if (rsiAtLastLow === null || rsiAtLastLow > 45) {
            result.details.push('✗ RSI不够低: ' + (rsiAtLastLow ? rsiAtLastLow.toFixed(1) : '--') + ' > 45');
            return result;
        }

        // === 前置过滤⑥：背离期间成交量萎缩 ===
        var volFirst = recentLows[0].volume;
        var volLast = dailyBars[lastDiv.priceIdx].volume;
        if (volFirst > 0 && volLast > volFirst * 0.8) {
            result.details.push('△ 量未萎缩: 背离段末量≥首量×0.8');
            // 不淘汰，但标记
        }

        result.found = true;
        result.segments = divergences.length + 1;
        result.divergencePoints = divergences;
        result.daysSinceLastLow = daysSince;
        result.drawdown60 = drawdown60;
        result.rsiAtLow = rsiAtLastLow;

        // RSI底背离确认
        var prevRsi = null;
        for (var r = divergences.length - 2; r >= 0; r--) {
            var prv = rsi[divergences[r].priceIdx];
            if (prv !== null) { prevRsi = prv; break; }
        }
        if (rsiAtLastLow !== null && prevRsi !== null && rsiAtLastLow > prevRsi) {
            result.rsiConfirm = true;
        }

        result.details.push(
            '✓ MACD底背离: ' + result.segments + '段 | ' +
            '回撤' + drawdown60.toFixed(1) + '% | ' +
            'RSI:' + rsiAtLastLow.toFixed(0) + '(确认:' + (result.rsiConfirm?'是':'否') + ') | ' +
            '距低' + daysSince + '天'
        );

        return result;
    }

    // ===== 阶段3：入场信号（严格版）=====
    function checkEntrySignal(dailyBars, today, divergenceResult, opts) {
        opts = opts || {};
        var volMin = opts.volMin || 1.5;

        var result = {
            signal: false,
            priceBreak: false,
            volExpand: false,
            closeStrong: false,
            bullishCandle: false,
            breakPct: 0,
            volRatio: 0,
            closePct: 0,
            details: []
        };

        var todayHigh = today.high || today.price;
        var todayPrice = today.price;
        var todayOpen = today.open || today.price;
        var todayVol = today.volume;

        if (divergenceResult.daysSinceLastLow > 20) {
            result.details.push('✗ 背离过期' + divergenceResult.daysSinceLastLow + '天');
            return result;
        }

        // ① 阳线确认
        if (todayPrice > todayOpen && todayPrice > 0 && todayOpen > 0) {
            result.bullishCandle = true;
            result.details.push('✓ 今日阳线');
        } else {
            result.details.push('✗ 今日非阳线，等阳线确认');
            return result;
        }

        // ② 阳线实体 ≥ 1.5%（不是小十字星）
        var bodyPct = todayOpen > 0 ? (todayPrice - todayOpen) / todayOpen * 100 : 0;
        if (bodyPct < 1.0) {
            result.details.push('✗ 阳线实体太小 ' + bodyPct.toFixed(2) + '% < 1%');
            return result;
        }

        // ③ 突破近期阻力（最近10天高点 或 上一背离点以来高点）
        var len = dailyBars.length;
        var divStartIdx = divergenceResult.divergencePoints.length > 0 ?
            divergenceResult.divergencePoints[0].priceIdx : len - 20;
        var recentHigh = -Infinity;
        for (var i = divStartIdx; i < len - 1; i++) {
            if (i >= 0 && dailyBars[i].high > recentHigh) recentHigh = dailyBars[i].high;
        }
        if (todayHigh > recentHigh) {
            result.priceBreak = true;
            result.breakPct = (todayHigh - recentHigh) / recentHigh * 100;
            result.details.push('✓ 突破阻力 ' + recentHigh.toFixed(2) + ' +' + result.breakPct.toFixed(2) + '%');
        } else {
            result.details.push('△ 未突破阻力位（W底右腿可以等确认）');
            // 不淘汰，但要提示
            result.priceBreak = true; // 底背离早期反弹允许不突破
        }

        // ④ 放量
        var sumVol10 = 0;
        for (var i2 = len - 11; i2 < len - 1; i2++) {
            if (i2 >= 0) sumVol10 += dailyBars[i2].volume;
        }
        var avgVol10 = sumVol10 / 10;
        if (todayVol > 0 && avgVol10 > 0) {
            result.volRatio = todayVol / avgVol10;
            if (result.volRatio >= volMin) {
                result.volExpand = true;
                result.details.push('✓ 放量 ×' + result.volRatio.toFixed(2));
            } else {
                result.details.push('△ 量比×' + result.volRatio.toFixed(2) + ' < ' + volMin);
            }
        }

        // ⑤ 收盘强度
        result.closePct = todayHigh > 0 ? todayPrice / todayHigh : 0;
        if (result.closePct >= closeStrongPct) {
            result.closeStrong = true;
            result.details.push('✓ 收盘强势 ' + (result.closePct*100).toFixed(0) + '%');
        } else {
            result.details.push('△ 收' + (result.closePct*100).toFixed(0) + '% 偏弱');
        }

        // 综合：阳线实体≥1% + (放量 或 收盘强势)
        result.signal = result.bullishCandle && (result.volExpand || result.closeStrong);
        if (result.signal) result.details.push('★★★ MACD底背离入场信号！');

        return result;
    }

    // ===== 主流程 =====
    document.getElementById('btnRefresh').addEventListener('click', runScreening);

    async function runScreening() {
        clearResults();

        if (!isTradingTime()) {
            var status = getMarketStatus();
            var ok = await myConfirm('当前' + status.text + '。实时筛选需交易时段，是否仍用最近收盘数据尝试？');
            if (!ok) return;
        }

        hideError(); setRefreshButton(true);
        debugLines = [];
        debugLog('=== 半木夏 MACD底背离（严格版）===');
        debugLog('条件: ' + divergeMin + '段背离 | 回撤≥8% | RSI<45 | 价跌≥3% | 柱升≥10% | 距低≤20天');
        debugLog('涨幅≥' + changeMin + '% | 阳线实体≥1% | 量比≥' + entryVolMin + ' | 收≥' + (closeStrongPct*100).toFixed(0) + '%');
        debugLog('时间: ' + new Date().toLocaleTimeString());
        debugLog('');

        try {
            // ===== 阶段1：海选 =====
            showLoading('海选涨幅榜...', '涨幅≥' + changeMin + '%');
            var candidates = await getRisingStocks(debugLog, changeMin);
            debugLog('阶段1 候选: ' + candidates.length + '只');

            if (candidates.length === 0) {
                debugLog('无候选，停止');
                showResults([]);
                finishRefresh();
                return;
            }

            // ===== 阶段2：MACD背离检测 =====
            showLoading('计算MACD背离...', '候选' + candidates.length + '只，拉取250日K线');
            var finalStocks = [];
            var batchSize = 2;
            var processed = 0, errors = 0;
            var divergeFound = 0;

            for (var bi = 0; bi < candidates.length; bi += batchSize) {
                var batch = candidates.slice(bi, bi + batchSize);

                var promises = batch.map(function(stock) {
                    return fetchDailyKline250(stock.code).then(function(bars) {
                        return { stock: stock, bars: bars, error: null };
                    }).catch(function(e) {
                        return { stock: stock, bars: [], error: e.message };
                    });
                });

                var results = await Promise.all(promises);

                for (var ri = 0; ri < results.length; ri++) {
                    var r = results[ri];
                    if (r.error || r.bars.length < 60) {
                        if (r.error) errors++;
                        processed++;
                        continue;
                    }

                    // MACD背离检测
                    var div = detectMACDDivergence(r.bars, {
                        minSegments: divergeMin,
                        lookback: divergeLookback
                    });

                    if (!div.found) { processed++; continue; }
                    divergeFound++;

                    // 入场确认
                    var today = {
                        price: r.stock.price,
                        high: r.stock.high,
                        low: r.stock.low,
                        open: r.stock.open,
                        volume: r.stock.volume,
                        turnover: r.stock.turnover
                    };

                    var entry = checkEntrySignal(r.bars, today, div, {
                        volMin: entryVolMin
                    });

                    if (entry.signal) {
                        finalStocks.push({
                            code: r.stock.code,
                            name: r.stock.name,
                            price: r.stock.price,
                            change: r.stock.change,
                            turnover: r.stock.turnover,
                            nmc: r.stock.nmc,
                            divResult: div,
                            entryResult: entry,
                            bars: r.bars  // 保留K线用于渲染
                        });
                    }
                    processed++;
                }

                var pct = Math.round(processed / candidates.length * 100);
                showLoading('检测MACD背离...',
                    processed + '/' + candidates.length + ' (' + pct + '%) ' +
                    '背离' + divergeFound + ' 信号' + finalStocks.length);

                if (bi + batchSize < candidates.length) await delay(500);
            }

            debugLog('');
            debugLog('=== 完成 ===');
            debugLog('候选:' + candidates.length + ' | 背离发现:' + divergeFound + ' | 最终信号:' + finalStocks.length + ' | 错误:' + errors);

            if (finalStocks.length > 0) {
                debugLog('');
                finalStocks.forEach(function(s, idx) {
                    debugLog('【' + (idx+1) + '】' + s.code + ' ' + s.name + ' +' + s.change.toFixed(2) + '%');
                    debugLog('  背离: ' + s.divResult.details.join(' | '));
                    debugLog('  入场: ' + s.entryResult.details.join(' | '));
                });
            } else {
                debugLog('无MACD底背离信号。建议：降低背离段数(2段)、放大扫描区间、降低涨幅下限');
            }

            showResults(finalStocks);
            finishRefresh();

        } catch (e) {
            debugLog('!! ' + (e.message || e));
            showError(e.message || '筛选失败');
            setRefreshButton(false);
            hideLoading();
        }
    }

    // ===== UI =====
    function clearResults() {
        showResultSection('resultArea', false);
        document.getElementById('listResult').innerHTML = '';
        document.getElementById('countResult').textContent = '0';
    }

    function showResults(stocks) {
        showResultSection('resultArea', true);
        updateResultCount('countResult', stocks.length);
        document.getElementById('resultBadge').textContent = 'MACD底背离';
        renderDivergenceList('listResult', stocks);
    }

    function renderDivergenceList(containerId, stocks) {
        var container = document.getElementById(containerId);
        if (!stocks || stocks.length === 0) {
            container.innerHTML = '<div class="empty-state" style="padding:20px"><p class="empty-text">无MACD底背离入场信号</p><p class="empty-hint">底背离是反转信号，通常出现在下跌末端，需要耐心等待</p></div>';
            return;
        }

        var html = '';
        stocks.forEach(function(s) {
            var div = s.divResult;
            var ent = s.entryResult;
            var mktCapYi = s.nmc ? (s.nmc / 100000000).toFixed(0) : '--';

            // 背离点详情
            var divPointsHtml = '';
            div.divergencePoints.forEach(function(dp) {
                divPointsHtml += '<span class="macd-div-dot">' + dp.date + ' 价' + dp.priceLow.toFixed(2) + '</span>';
            });

            html += '<div class="stock-card" style="border-left:3px solid #E91E63;">' +
                '<div class="stock-card-header">' +
                    '<div><span class="stock-code">' + s.code + '</span>' +
                    '<span class="stock-name">' + s.name + '</span></div>' +
                    '<span class="stock-change up">+' + s.change.toFixed(2) + '%</span>' +
                '</div>' +
                '<div class="stock-details">' +
                    '<div class="detail-item"><span class="detail-label">现价</span><span class="detail-value">' + s.price.toFixed(2) + '</span></div>' +
                    '<div class="detail-item"><span class="detail-label">换手率</span><span class="detail-value">' + s.turnover.toFixed(2) + '%</span></div>' +
                    '<div class="detail-item"><span class="detail-label">流通市值</span><span class="detail-value">' + mktCapYi + '亿</span></div>' +
                '</div>' +
                // 背离路径
                '<div class="flag-path">' +
                    '<span class="flag-step">📉 下跌</span>' +
                    '<span class="flag-arrow">→</span>' +
                    '<span class="flag-step">🔄 ' + div.segments + '段底背离</span>' +
                    '<span class="flag-arrow">→</span>' +
                    '<span class="flag-step fire">📈 反弹确认</span>' +
                '</div>' +
                // 背离详情
                '<div class="flag-detail-row">' +
                    '<span class="flag-label">背离点</span>' +
                    '<span class="flag-val">' + divPointsHtml + '</span>' +
                '</div>' +
                '<div class="flag-detail-row">' +
                    '<span class="flag-label">下跌</span>' +
                    '<span class="flag-val">60日回撤' + (div.drawdown60 ? div.drawdown60.toFixed(1) : '--') + '% | RSI低点' + (div.rsiAtLow ? div.rsiAtLow.toFixed(0) : '--') + '</span>' +
                '</div>' +
                '<div class="flag-detail-row">' +
                    '<span class="flag-label">背离</span>' +
                    '<span class="flag-val">' + div.segments + '段 | RSI背离:' + (div.rsiConfirm ? '✅' : '❌') + ' | 距低' + div.daysSinceLastLow + '天</span>' +
                '</div>' +
                '<div class="flag-detail-row">' +
                    '<span class="flag-label">入场</span>' +
                    '<span class="flag-val">' + ent.details.join(' | ') + '</span>' +
                '</div>' +
            '</div>';
        });
        container.innerHTML = html;
    }

    function finishRefresh() {
        hideLoading(); setRefreshButton(false);
        var now = new Date();
        var ts = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ':' + now.getSeconds().toString().padStart(2, '0');
        updateLastRefresh(ts); updateMarketStatus();
    }

})();

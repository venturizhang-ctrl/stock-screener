/**
 * williams.js — Larry Williams 外包线反转策略 A股适配版
 *
 * 核心逻辑：
 * 阶段1（外包检测）：近3天内出现外包线（吞没前K线高低点）
 *                    + 收盘跌破前低（恐慌杀跌）→ 潜在反转
 * 阶段2（%R确认）：Williams %R超卖（<-80），确认衰竭
 * 阶段3（入场）：今日阳线反弹 + %R回升 + 放量 → 入场
 *
 * A股适配：
 * - 只做多头反转（A股T+1无做空）
 * - 日线级别执行
 * - 增加威廉%R超卖过滤
 */

(function() {

    updateMarketStatus();

    // ===== 可调参数 =====
    var changeMin = 1.0;
    var williamsPeriod = 14;     // %R周期
    var williamsOversold = -80;  // %R超卖阈值
    var outsideMaxDays = 2;      // 外包线最近天数
    var bodySizeMin = 1.5;       // 外包线实体 ≥ 前K线×倍数
    var entryVolMin = 1.2;       // 入场放量
    var closeStrongPct = 0.85;   // 收盘强势

    var debugLines = [];
    function debugLog(msg) {
        console.log(msg);
        debugLines.push(msg);
        var el = document.getElementById('debugText');
        if (el) el.textContent = debugLines.join('\n');
    }

    // ===== 参数 =====
    (function() {
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

    // ===== Williams %R =====
    function calcWilliamsR(bars, period) {
        period = period || 14;
        var result = [];
        for (var i = 0; i < bars.length; i++) {
            if (i < period - 1) { result.push(null); continue; }
            var hh = -Infinity, ll = Infinity;
            for (var j = i - period + 1; j <= i; j++) {
                if (bars[j].high > hh) hh = bars[j].high;
                if (bars[j].low < ll) ll = bars[j].low;
            }
            var wr = hh > ll ? (hh - bars[i].close) / (hh - ll) * -100 : 0;
            result.push(wr);
        }
        return result;
    }

    // ===== 日K线（120根）=====
    function fetchDailyKline120(code) {
        return new Promise(function(resolve, reject) {
            var c = code.toString();
            var symbol = (c.startsWith('6') || c.startsWith('9') ? 'sh' : 'sz') + c;
            var cb = 'dwl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
            var timer = setTimeout(function() { cleanup(); reject(new Error('超时')); }, 10000);
            function cleanup() {
                clearTimeout(timer); delete window[cb];
                if (script && script.parentNode) script.parentNode.removeChild(script);
            }
            window[cb] = function(data) {
                cleanup();
                try {
                    if (!data || !Array.isArray(data)) { reject(new Error('无数据')); return; }
                    var bars = [];
                    for (var i = 0; i < data.length; i++) {
                        var bar = data[i];
                        bars.push({
                            date: bar.day.split(' ')[0],
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
                '&scale=240&ma=no&datalen=120';
            script.onerror = function() { cleanup(); reject(new Error('网络错误')); };
            document.body.appendChild(script);
        });
    }

    // ===== 阶段2：外包线检测（严格版）=====
    function detectOutsideBar(dailyBars, opts) {
        opts = opts || {};
        var maxDays = opts.maxDays || 3;
        var bodyMin = opts.bodySizeMin || 1.5;

        var result = {
            found: false,
            outsideBar: null,
            details: []
        };

        if (dailyBars.length < 30) {
            result.details.push('K线不足30条');
            return result;
        }

        var len = dailyBars.length;

        // 扫描最近N天（d < len 包含昨天）
        for (var d = len - 1; d >= Math.max(1, len - maxDays); d--) {
            var bar = dailyBars[d];
            var prev = dailyBars[d - 1];

            var barHigh = bar.high, barLow = bar.low;
            var prevHigh = prev.high, prevLow = prev.low;

            // === 外包条件：同时吞没上沿和下沿 ===
            if (!(barHigh > prevHigh && barLow < prevLow)) continue;

            // === 阴包阳：前一根必须是阳线（多头昨天赢过，今天才谈得上被反杀）===
            if (!(prev.close > prev.open)) continue;

            // === 收盘<前低 → 多头今天彻底溃败 ===
            if (!(bar.close < prevLow)) continue;

            var barBody = Math.abs(bar.close - bar.open);
            var prevBody = Math.abs(prev.close - prev.open);
            var barRange = barHigh - barLow;

            // === 实体过滤 ===
            // ① 外包线自身实体 ≥ 前K线实体×倍数
            if (prevBody > 0 && barBody < prevBody * bodyMin) continue;
            // ② 实体不能是十字星（≥前K线实体的0.5倍，覆盖prevBody=0的情况）
            if (barBody < prevBody * 0.5) continue;

            // === 收盘位置：必须收在K线下1/4区域（底部25%），确认多头完败 ===
            if (barRange > 0) {
                var closePosition = (bar.close - barLow) / barRange;
                if (closePosition > 0.35) continue; // 没收在底部35%以内 → 不够极端
            }

            // === 前K线不能太小（排除窄幅横盘中的伪外包）===
            var prevRange = prevHigh - prevLow;
            if (prevRange <= 0) continue;
            // 外包必须真正"吞没"——新K线低点至少要跌破前低1%以上（不是擦边）
            var breakPct = (prevLow - barLow) / prevRange * 100;
            if (breakPct < 5) continue;

            // === 找到了！===
            result.outsideBar = {
                idx: d,
                date: bar.date,
                open: bar.open, close: bar.close,
                high: bar.high, low: bar.low,
                volume: bar.volume,
                bodyRatio: prevBody > 0 ? (barBody / prevBody) : 999,
                prevHigh: prevHigh, prevLow: prevLow,
                closePosition: closePosition,
                breakPct: breakPct,
                barRange: barRange
            };
            result.found = true;
            result.daysAgo = len - 1 - d;
            break;
        }

        if (!result.found) {
            result.details.push('✗ 近' + maxDays + '天内无合格外包线');
            return result;
        }

        var ob = result.outsideBar;
        result.details.push(
            '✓ 外包线: ' + ob.date +
            ' 高' + ob.high.toFixed(2) + '>' + ob.prevHigh.toFixed(2) +
            ' 低' + ob.low.toFixed(2) + '<' + ob.prevLow.toFixed(2) +
            ' 实体×' + ob.bodyRatio.toFixed(1) +
            ' 收底' + (ob.closePosition*100).toFixed(0) + '%'
        );

        return result;
    }

    // ===== 阶段3：%R超卖 + 入场确认 =====
    function checkWilliamsEntry(dailyBars, today, outsideResult, opts) {
        opts = opts || {};
        var oversold = opts.williamsOversold || -80;
        var period = opts.williamsPeriod || 14;
        var volMin = opts.entryVolMin || 1.2;

        var result = {
            signal: false,
            bullishCandle: false,
            wrOversold: false,
            wrTurning: false,
            volConfirm: false,
            closeStrong: false,
            wrValue: null,
            wrPrevValue: null,
            volRatio: 0,
            closePct: 0,
            details: []
        };

        var todayHigh = today.high || today.price;
        var todayPrice = today.price;
        var todayOpen = today.open || today.price;
        var todayVol = today.volume;

        var ob = outsideResult.outsideBar;
        var len = dailyBars.length;

        // === %R计算 ===
        var wr = calcWilliamsR(dailyBars, period);
        var wrNow = wr[len - 1];       // 昨日的%R
        var wrPrev = wr[len - 2];      // 前日

        // 用今日实时价格更新%R（近似）
        // 查找period内最高和最低
        var hh = -Infinity, ll = Infinity;
        for (var i = len - period; i < len - 1; i++) {
            if (i >= 0) {
                if (dailyBars[i].high > hh) hh = dailyBars[i].high;
                if (dailyBars[i].low < ll) ll = dailyBars[i].low;
            }
        }
        if (todayHigh > hh) hh = todayHigh;
        if (today.low > 0 && today.low < ll) ll = today.low;
        var wrToday = hh > ll ? (hh - todayPrice) / (hh - ll) * -100 : 0;

        result.wrValue = wrToday;
        result.wrPrevValue = wrNow;

        // ① %R超卖
        if (wrNow !== null && wrNow <= oversold) {
            result.wrOversold = true;
            result.details.push('✓ %R超卖 ' + wrNow.toFixed(0) + ' ≤ ' + oversold);
        } else if (wrToday <= oversold) {
            result.wrOversold = true;
            result.details.push('✓ %R实时超卖 ' + wrToday.toFixed(0));
        } else {
            result.details.push('△ %R=' + (wrNow ? wrNow.toFixed(0) : wrToday.toFixed(0)) + ' 未超卖(>' + oversold + ')');
            // 不淘汰，宽松处理
        }

        // ② %R回升（昨日在超卖，今日上升）
        if (wrNow !== null && wrPrev !== null && wrNow > wrPrev && wrNow <= -50) {
            result.wrTurning = true;
            result.details.push('✓ %R回升 ' + wrPrev.toFixed(0) + '→' + wrNow.toFixed(0));
        }

        // ③ 今日阳线
        if (todayPrice > todayOpen && todayOpen > 0) {
            result.bullishCandle = true;
            var body = (todayPrice - todayOpen) / todayOpen * 100;
            result.details.push('✓ 阳线 +' + body.toFixed(2) + '%');
            if (body < 0.5) {
                result.details.push('✗ 实体太小');
                return result;
            }
        } else {
            result.details.push('✗ 非阳线');
            return result;
        }

        // ④ 放量
        var sumVol20 = 0, cnt20 = 0;
        for (var k = len - 21; k < len - 1; k++) {
            if (k >= 0) { sumVol20 += dailyBars[k].volume; cnt20++; }
        }
        var avgVol20 = cnt20 > 0 ? sumVol20 / cnt20 : 0;
        if (todayVol > 0 && avgVol20 > 0) {
            result.volRatio = todayVol / avgVol20;
            if (result.volRatio >= volMin) {
                result.volConfirm = true;
                result.details.push('✓ 放量 ×' + result.volRatio.toFixed(2));
            } else {
                result.details.push('△ 量比×' + result.volRatio.toFixed(2));
            }
        }

        // ⑤ 收盘强势
        result.closePct = todayHigh > 0 ? todayPrice / todayHigh : 0;
        if (result.closePct >= closeStrongPct) {
            result.closeStrong = true;
            result.details.push('✓ 收盘强势 ' + (result.closePct*100).toFixed(0) + '%');
        } else {
            result.details.push('△ 收盘' + (result.closePct*100).toFixed(0) + '%');
        }

        // 综合：阳线 + (%R超卖或回升) + (放量或收盘强势)
        result.signal = result.bullishCandle &&
                        (result.wrOversold || result.wrTurning) &&
                        (result.volConfirm || result.closeStrong);

        if (result.signal) result.details.push('★★★ Williams外包线反转！');

        return result;
    }

    // ===== 主流程 =====
    document.getElementById('btnRefresh').addEventListener('click', runScreening);

    async function runScreening() {
        clearResults();
        if (!isTradingTime()) {
            var status = getMarketStatus();
            var ok = await myConfirm('当前' + status.text + '。仍用最近收盘数据尝试？');
            if (!ok) return;
        }

        hideError(); setRefreshButton(true);
        debugLines = [];
        debugLog('=== Larry Williams 外包线反转 ===');
        debugLog('外包线: 近' + outsideMaxDays + '天 | 实体≥×' + bodySizeMin + ' | 收底≤35% | 跌破前低≥5%');
        debugLog('%R:' + williamsPeriod + '周期 超卖<' + williamsOversold + ' | 阳线+量≥×' + entryVolMin + ' | 收≥' + (closeStrongPct*100).toFixed(0) + '%');
        debugLog('时间: ' + new Date().toLocaleTimeString());
        debugLog('');

        try {
            showLoading('海选涨幅榜...', '涨幅≥' + changeMin + '%');
            var candidates = await getRisingStocks(debugLog, changeMin);
            debugLog('阶段1 候选: ' + candidates.length + '只');

            if (candidates.length === 0) {
                debugLog('无候选');
                showResults([]); finishRefresh(); return;
            }

            showLoading('检测外包线...', '候选' + candidates.length + '只');
            var finalStocks = [];
            var batchSize = 3;
            var processed = 0, errors = 0, outsideFound = 0;

            for (var bi = 0; bi < candidates.length; bi += batchSize) {
                var batch = candidates.slice(bi, bi + batchSize);
                var promises = batch.map(function(stock) {
                    return fetchDailyKline120(stock.code).then(function(bars) {
                        return { stock: stock, bars: bars, error: null };
                    }).catch(function(e) {
                        return { stock: stock, bars: [], error: e.message };
                    });
                });
                var results = await Promise.all(promises);

                for (var ri = 0; ri < results.length; ri++) {
                    var r = results[ri];
                    if (r.error || r.bars.length < 30) { if (r.error) errors++; processed++; continue; }

                    var today = {
                        price: r.stock.price, high: r.stock.high,
                        low: r.stock.low, open: r.stock.open,
                        volume: r.stock.volume, turnover: r.stock.turnover
                    };

                    var outside = detectOutsideBar(r.bars, {
                        maxDays: outsideMaxDays, bodySizeMin: bodySizeMin
                    });
                    if (!outside.found) { processed++; continue; }
                    outsideFound++;

                    var entry = checkWilliamsEntry(r.bars, today, outside, {
                        williamsOversold: williamsOversold,
                        williamsPeriod: williamsPeriod,
                        entryVolMin: entryVolMin
                    });

                    if (entry.signal) {
                        finalStocks.push({
                            code: r.stock.code, name: r.stock.name,
                            price: r.stock.price, change: r.stock.change,
                            turnover: r.stock.turnover, nmc: r.stock.nmc,
                            outsideResult: outside, entryResult: entry
                        });
                    }
                    processed++;
                }

                var pct = Math.round(processed / candidates.length * 100);
                showLoading('检测外包线...',
                    processed + '/' + candidates.length + ' (' + pct + '%) ' +
                    '外包' + outsideFound + ' 信号' + finalStocks.length);
                if (bi + batchSize < candidates.length) await delay(300);
            }

            debugLog('');
            debugLog('=== 完成 ===');
            debugLog('候选:' + candidates.length + ' | 外包发现:' + outsideFound + ' | 反转信号:' + finalStocks.length + ' | 错误:' + errors);

            if (finalStocks.length > 0) {
                finalStocks.forEach(function(s, idx) {
                    debugLog('【' + (idx+1) + '】' + s.code + ' ' + s.name + ' +' + s.change.toFixed(2) + '%');
                    debugLog('  外包: ' + s.outsideResult.details.join(' | '));
                    debugLog('  入场: ' + s.entryResult.details.join(' | '));
                });
            } else {
                debugLog('无外包线反转信号。这是稀有形态，通常几天才一只。');
            }

            showResults(finalStocks); finishRefresh();
        } catch (e) {
            debugLog('!! ' + (e.message || e));
            showError(e.message || '筛选失败');
            setRefreshButton(false); hideLoading();
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
        document.getElementById('resultBadge').textContent = '外包反转';
        renderWilliamsList('listResult', stocks);
    }

    function renderWilliamsList(containerId, stocks) {
        var container = document.getElementById(containerId);
        if (!stocks || stocks.length === 0) {
            container.innerHTML = '<div class="empty-state" style="padding:20px"><p class="empty-text">无外包线反转信号</p><p class="empty-hint">外包线+%R超卖+阳线确认，稀有反转形态</p></div>';
            return;
        }
        var html = '';
        stocks.forEach(function(s) {
            var ob = s.outsideResult.outsideBar;
            var ent = s.entryResult;
            var mktCapYi = s.nmc ? (s.nmc / 100000000).toFixed(0) : '--';

            html += '<div class="stock-card" style="border-left:3px solid #9C27B0;">' +
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
                '<div class="flag-path">' +
                    '<span class="flag-step" style="background:#2A1A3E;color:#CE93D8;">📦 外包吞噬</span>' +
                    '<span class="flag-arrow">→</span>' +
                    '<span class="flag-step">📉 %R超卖</span>' +
                    '<span class="flag-arrow">→</span>' +
                    '<span class="flag-step fire">🔄 反转!</span>' +
                '</div>' +
                '<div class="flag-detail-row">' +
                    '<span class="flag-label">外包日</span>' +
                    '<span class="flag-val">' + ob.date + ' | 体×' + ob.bodyRatio.toFixed(1) + ' | 收底' + (ob.closePosition*100).toFixed(0) + '% | 跌破' + ob.breakPct.toFixed(1) + '% | 距' + s.outsideResult.daysAgo + '天</span>' +
                '</div>' +
                '<div class="flag-detail-row">' +
                    '<span class="flag-label">%R</span>' +
                    '<span class="flag-val">当前' + (ent.wrValue ? ent.wrValue.toFixed(0) : '--') + ' | 前值' + (ent.wrPrevValue ? ent.wrPrevValue.toFixed(0) : '--') + ' | 超卖:' + (ent.wrOversold?'✅':'❌') + ' | 回升:' + (ent.wrTurning?'✅':'❌') + '</span>' +
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

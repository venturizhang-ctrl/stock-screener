/**
 * flight.js — 韩国交易员 Flight 恐慌反转策略 A股适配版
 *
 * 核心逻辑：
 * 阶段1（支撑识别）：找20日/60日低点作为关键支撑位
 * 阶段2（恐慌检测）：近5天内出现放量阴线触及支撑位 → 恐慌抛售
 * 阶段3（反转确认）：今日阳线反弹，站上支撑位上方，放量确认
 *
 * A股适配：
 * - 原版20-50倍杠杆 → 无杠杆，仓位10-20%替代
 * - 原版反弹10%止盈 → 保持，约A股1-2个涨停
 * - 原版恐慌砸盘 → 放量阴线+触及支撑位
 */

(function() {

    updateMarketStatus();

    // ===== 可调参数 =====
    var changeMin = 1.0;         // 今日涨幅下限
    var panicVolMin = 1.5;       // 恐慌日最低量比（vs 20日均量）
    var panicDropMin = 3.0;      // 恐慌日最低跌幅%
    var supportNearPct = 5.0;    // 触及支撑位的距离阈值%
    var entryVolMin = 1.2;       // 入场日最低量比
    var closeStrongPct = 0.85;   // 收盘强势阈值
    var maxPanicDays = 5;        // 恐慌日最近天数

    var debugLines = [];
    function debugLog(msg) {
        console.log(msg);
        debugLines.push(msg);
        var el = document.getElementById('debugText');
        if (el) el.textContent = debugLines.join('\n');
    }

    // ===== 参数调整 =====
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

    // ===== 日K线（120根）=====
    function fetchDailyKline120(code) {
        return new Promise(function(resolve, reject) {
            var c = code.toString();
            var symbol = (c.startsWith('6') || c.startsWith('9') ? 'sh' : 'sz') + c;
            var cb = 'dfl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

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
                '&scale=240&ma=no&datalen=120';
            script.onerror = function() { cleanup(); reject(new Error('网络错误')); };
            document.body.appendChild(script);
        });
    }

    // ===== 阶段2：Flight恐慌反转检测 =====
    function detectFlightSetup(dailyBars, today, opts) {
        opts = opts || {};
        var volMin = opts.panicVolMin || 1.5;
        var dropMin = opts.panicDropMin || 3.0;
        var nearPct = opts.supportNearPct || 5.0;

        var result = {
            found: false,
            panicDay: null,
            supportLevel: null,
            supportType: '',
            details: []
        };

        if (dailyBars.length < 60) {
            result.details.push('K线不足60条');
            return result;
        }

        var len = dailyBars.length;

        // === 计算支撑位 ===
        // 支撑1：20日最低价
        var low20 = Infinity;
        for (var i = len - 21; i < len - 1; i++) {
            if (i >= 0 && dailyBars[i].low < low20) low20 = dailyBars[i].low;
        }
        // 支撑2：60日最低价
        var low60 = Infinity;
        for (var j = len - 61; j < len - 1; j++) {
            if (j >= 0 && dailyBars[j].low < low60) low60 = dailyBars[j].low;
        }

        // === 计算20日均量 ===
        var sumVol20 = 0, count20 = 0;
        for (var k = len - 21; k < len - 1; k++) {
            if (k >= 0) { sumVol20 += dailyBars[k].volume; count20++; }
        }
        var avgVol20 = count20 > 0 ? sumVol20 / count20 : 0;

        // === 前置过滤：必须有明显回撤 ===
        var high60 = -Infinity;
        for (var h = len - 61; h < len - 1; h++) {
            if (h >= 0 && dailyBars[h].high > high60) high60 = dailyBars[h].high;
        }
        var drawdown = high60 > 0 ? (high60 - today.price) / high60 * 100 : 0;
        if (drawdown < 5) {
            result.details.push('✗ 无回撤: 距60日高仅' + drawdown.toFixed(1) + '%');
            return result;
        }

        // === 扫描最近N天的恐慌日 ===
        var panicDays = [];
        for (var d = len - maxPanicDays - 1; d < len - 1; d++) {
            if (d < 0) continue;
            var bar = dailyBars[d];

            // 必须阴线
            if (bar.close >= bar.open) continue;

            // 跌幅 ≥ 阈值
            var drop = (bar.open - bar.close) / bar.open * 100;
            if (drop < dropMin) continue;

            // 放量 ≥ 阈值
            var volRatio = avgVol20 > 0 ? bar.volume / avgVol20 : 0;
            if (volRatio < volMin) continue;

            // 触及支撑位（距20日低或60日低 ≤ nearPct%）
            var to20 = low20 > 0 ? (bar.low - low20) / low20 * 100 : 999;
            var to60 = low60 > 0 ? (bar.low - low60) / low60 * 100 : 999;
            var nearestSupport = Math.min(to20, to60);
            if (nearestSupport > nearPct) continue;

            // 这是恐慌日！
            var supportType = to20 <= to60 ? '20日低' : '60日低';
            var supportLevel = to20 <= to60 ? low20 : low60;

            panicDays.push({
                idx: d,
                date: bar.date,
                open: bar.open,
                close: bar.close,
                low: bar.low,
                high: bar.high,
                volume: bar.volume,
                drop: drop,
                volRatio: volRatio,
                supportType: supportType,
                supportLevel: supportLevel,
                toSupport: nearestSupport
            });
        }

        if (panicDays.length === 0) {
            result.details.push('✗ 近' + maxPanicDays + '天内无恐慌日（放量阴线+触支撑）');
            return result;
        }

        // 取最近的恐慌日
        var panic = panicDays[panicDays.length - 1];
        result.panicDay = panic;
        result.supportLevel = panic.supportLevel;
        result.supportType = panic.supportType;
        result.daysSincePanic = len - 1 - panic.idx;

        result.details.push(
            '✓ 恐慌日: ' + panic.date + ' 跌' + panic.drop.toFixed(1) +
            '% 量×' + panic.volRatio.toFixed(1) + ' 触' + panic.supportType
        );
        result.details.push('  支撑位: ' + panic.supportLevel.toFixed(2) + ' 距' + panic.toSupport.toFixed(1) + '%');

        result.found = true;
        return result;
    }

    // ===== 阶段3：反转入场确认 =====
    function checkReversalEntry(dailyBars, today, flightResult, opts) {
        opts = opts || {};
        var volMin = opts.entryVolMin || 1.2;

        var result = {
            signal: false,
            bullishCandle: false,
            volConfirm: false,
            closeStrong: false,
            bounceFromSupport: false,
            volRatio: 0,
            closePct: 0,
            bouncePct: 0,
            details: []
        };

        var todayHigh = today.high || today.price;
        var todayLow = today.low || today.price;
        var todayPrice = today.price;
        var todayOpen = today.open || today.price;
        var todayVol = today.volume;
        var support = flightResult.supportLevel;

        // ① 今日阳线
        if (todayPrice > todayOpen && todayOpen > 0) {
            result.bullishCandle = true;
            var body = (todayPrice - todayOpen) / todayOpen * 100;
            result.details.push('✓ 阳线 +' + body.toFixed(2) + '%');
            if (body < 0.8) {
                result.details.push('✗ 阳线实体太小');
                return result;
            }
        } else {
            result.details.push('✗ 今日非阳线');
            return result;
        }

        // ② 从支撑位反弹（今日低点距支撑 ≤ 3%，收盘高于支撑 2%+）
        if (support > 0) {
            var lowToSupport = (todayLow - support) / support * 100;
            var closeToSupport = (todayPrice - support) / support * 100;
            if (closeToSupport > 2.0) {
                result.bounceFromSupport = true;
                result.bouncePct = closeToSupport;
                result.details.push('✓ 支撑反弹 +' + closeToSupport.toFixed(1) + '% (距支撑' + lowToSupport.toFixed(1) + '%)');
            } else {
                result.details.push('△ 支撑上方仅' + closeToSupport.toFixed(1) + '%（反弹力度不足）');
                // 不淘汰但提示
                result.bounceFromSupport = true;
            }
        }

        // ③ 放量确认（对比20日均量）
        var len = dailyBars.length;
        var sumVol20 = 0, cnt20 = 0;
        for (var i = len - 21; i < len - 1; i++) {
            if (i >= 0) { sumVol20 += dailyBars[i].volume; cnt20++; }
        }
        var avgVol20 = cnt20 > 0 ? sumVol20 / cnt20 : 0;
        if (todayVol > 0 && avgVol20 > 0) {
            result.volRatio = todayVol / avgVol20;
            if (result.volRatio >= volMin) {
                result.volConfirm = true;
                result.details.push('✓ 放量 ×' + result.volRatio.toFixed(2));
            } else {
                result.details.push('△ 量比×' + result.volRatio.toFixed(2) + ' < ' + volMin);
            }
        }

        // ④ 收盘强势
        result.closePct = todayHigh > 0 ? todayPrice / todayHigh : 0;
        if (result.closePct >= closeStrongPct) {
            result.closeStrong = true;
            result.details.push('✓ 收盘强势 ' + (result.closePct*100).toFixed(0) + '%');
        } else {
            result.details.push('△ 收盘' + (result.closePct*100).toFixed(0) + '% 偏弱');
        }

        // 综合判定
        result.signal = result.bullishCandle && result.bounceFromSupport &&
                        (result.volConfirm || result.closeStrong);
        if (result.signal) result.details.push('⚡ Flight恐慌反转信号！');

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
        debugLog('=== Flight 恐慌反转 ===');
        debugLog('条件: 近' + maxPanicDays + '天恐慌日(跌≥' + panicDropMin + '% +量≥×' + panicVolMin + ' +触支撑≤' + supportNearPct + '%)');
        debugLog('入场: 阳线 + 支撑反弹 + 量≥×' + entryVolMin + ' + 收≥' + (closeStrongPct*100).toFixed(0) + '%');
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

            // ===== 阶段2+3：恐慌检测 + 反转确认 =====
            showLoading('检测恐慌反转...', '候选' + candidates.length + '只，拉取120日K线');
            var finalStocks = [];
            var batchSize = 3;
            var processed = 0, errors = 0;
            var panicFound = 0;

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
                    if (r.error || r.bars.length < 60) {
                        if (r.error) errors++;
                        processed++;
                        continue;
                    }

                    var today = {
                        price: r.stock.price,
                        high: r.stock.high,
                        low: r.stock.low,
                        open: r.stock.open,
                        volume: r.stock.volume,
                        turnover: r.stock.turnover
                    };

                    // 恐慌检测
                    var flight = detectFlightSetup(r.bars, today, {
                        panicVolMin: panicVolMin,
                        panicDropMin: panicDropMin,
                        supportNearPct: supportNearPct
                    });

                    if (!flight.found) { processed++; continue; }
                    panicFound++;

                    // 反转确认
                    var entry = checkReversalEntry(r.bars, today, flight, {
                        entryVolMin: entryVolMin
                    });

                    if (entry.signal) {
                        finalStocks.push({
                            code: r.stock.code,
                            name: r.stock.name,
                            price: r.stock.price,
                            change: r.stock.change,
                            turnover: r.stock.turnover,
                            nmc: r.stock.nmc,
                            flightResult: flight,
                            entryResult: entry
                        });
                    }
                    processed++;
                }

                var pct = Math.round(processed / candidates.length * 100);
                showLoading('检测恐慌反转...',
                    processed + '/' + candidates.length + ' (' + pct + '%) ' +
                    '恐慌' + panicFound + ' 信号' + finalStocks.length);

                if (bi + batchSize < candidates.length) await delay(300);
            }

            debugLog('');
            debugLog('=== 完成 ===');
            debugLog('候选:' + candidates.length + ' | 恐慌发现:' + panicFound + ' | 反转信号:' + finalStocks.length + ' | 错误:' + errors);

            if (finalStocks.length > 0) {
                debugLog('');
                finalStocks.forEach(function(s, idx) {
                    debugLog('【' + (idx+1) + '】' + s.code + ' ' + s.name + ' +' + s.change.toFixed(2) + '%');
                    debugLog('  恐慌: ' + s.flightResult.details.join(' | '));
                    debugLog('  反转: ' + s.entryResult.details.join(' | '));
                });
            } else {
                debugLog('无Flight恐慌反转信号。正常——恐慌反转信号稀有，只在极端恐慌后出现。');
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
        document.getElementById('resultBadge').textContent = '恐慌反转';
        renderFlightList('listResult', stocks);
    }

    function renderFlightList(containerId, stocks) {
        var container = document.getElementById(containerId);
        if (!stocks || stocks.length === 0) {
            container.innerHTML = '<div class="empty-state" style="padding:20px"><p class="empty-text">无恐慌反转信号</p><p class="empty-hint">恐慌反转是极端情绪信号，通常只在市场恐慌性抛售后出现</p></div>';
            return;
        }

        var html = '';
        stocks.forEach(function(s) {
            var fl = s.flightResult;
            var ent = s.entryResult;
            var panic = fl.panicDay;
            var mktCapYi = s.nmc ? (s.nmc / 100000000).toFixed(0) : '--';

            html += '<div class="stock-card" style="border-left:3px solid #FF9800;">' +
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
                // 恐慌反转路径
                '<div class="flag-path">' +
                    '<span class="flag-step" style="background:#3A1A1A;color:#FF5252;">😱 恐慌 ' + panic.drop.toFixed(0) + '%</span>' +
                    '<span class="flag-arrow">→</span>' +
                    '<span class="flag-step">🛡️ 支撑 ' + fl.supportType + '</span>' +
                    '<span class="flag-arrow">→</span>' +
                    '<span class="flag-step fire">⚡ 反转!</span>' +
                '</div>' +
                '<div class="flag-detail-row">' +
                    '<span class="flag-label">恐慌日</span>' +
                    '<span class="flag-val">' + panic.date + ' | 跌' + panic.drop.toFixed(1) + '% | 量×' + panic.volRatio.toFixed(1) + ' | 触' + panic.supportType + '(' + panic.toSupport.toFixed(1) + '%)</span>' +
                '</div>' +
                '<div class="flag-detail-row">' +
                    '<span class="flag-label">支撑位</span>' +
                    '<span class="flag-val">' + fl.supportLevel.toFixed(2) + ' | 距恐慌日' + fl.daysSincePanic + '天</span>' +
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

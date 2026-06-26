/**
 * flag.js — 高窄旗形突破（High Tight Flag）
 *
 * Christian Kullamägi 核心策略 A股适配版
 *
 * 三步筛选：
 * 阶段1（海选）：今日涨幅≥2%，拉120根日K线
 * 阶段2（识旗）：识别"拉升30%+ → 紧窄缩量整理 → 不下均线"的旗形
 * 阶段3（引爆）：今日放量突破旗形上沿 → 信号确认
 *
 * A股适配：
 * - 原版 90-100%拉升 → 适配 30%+（约3-5个涨停）
 * - 原版回调 ≤ 15-25% → 适配 ≤ 20%振幅
 * - 原版 2周-2月整理 → 适配 10-40个交易日
 */

(function() {

    updateMarketStatus();

    // ===== 可调参数 =====
    var rallyMinGain = 30;     // 拉升最小涨幅%
    var flagMaxAmp = 20;       // 旗形最大振幅%
    var flagMinDays = 10;      // 旗形最短天数
    var flagMaxDays = 40;      // 旗形最长天数
    var volShrink = 0.7;       // 缩量系数（旗形量 < 拉升量×此值）
    var changeMin = 2.0;       // 今日涨幅下限
    var closeStrongPct = 0.90; // 收盘强势阈值

    var debugLines = [];
    function debugLog(msg) {
        console.log(msg);
        debugLines.push(msg);
        var el = document.getElementById('debugText');
        if (el) el.textContent = debugLines.join('\n');
    }

    // ===== 参数调整 =====
    var gainOptions = [
        { id: 'optGain30', val: 30 },
        { id: 'optGain40', val: 40 },
        { id: 'optGain50', val: 50 }
    ];
    gainOptions.forEach(function(opt) {
        var el = document.getElementById(opt.id);
        if (el) el.addEventListener('change', function() {
            if (this.checked) rallyMinGain = opt.val;
        });
    });

    var ampOptions = [
        { id: 'optAmp15', val: 15 },
        { id: 'optAmp20', val: 20 },
        { id: 'optAmp25', val: 25 }
    ];
    ampOptions.forEach(function(opt) {
        var el = document.getElementById(opt.id);
        if (el) el.addEventListener('change', function() {
            if (this.checked) flagMaxAmp = opt.val;
        });
    });

    var chgOptions = [
        { id: 'optChg1', val: 1 },
        { id: 'optChg2', val: 2 },
        { id: 'optChg3', val: 3 },
        { id: 'optChg5', val: 5 }
    ];
    chgOptions.forEach(function(opt) {
        var el = document.getElementById(opt.id);
        if (el) el.addEventListener('change', function() {
            if (this.checked) changeMin = opt.val;
        });
    });

    // ===== 日K线（120根）=====
    function fetchDailyKline120(code) {
        return new Promise(function(resolve, reject) {
            var c = code.toString();
            var symbol = (c.startsWith('6') || c.startsWith('9') ? 'sh' : 'sz') + c;
            var cb = 'dkf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

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
                    if (!data || !Array.isArray(data)) {
                        reject(new Error('无数据'));
                        return;
                    }
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

    // ===== EMA 计算 =====
    function calcEMA(bars, period) {
        if (bars.length < period) return [];
        var ema = [];
        var k = 2 / (period + 1);

        // 初始值用SMA
        var sum = 0;
        for (var i = 0; i < period; i++) {
            sum += bars[i].close;
        }
        var prevEma = sum / period;

        // 前period-1个位置填null，从第period-1个开始有值
        for (var i = 0; i < period - 1; i++) {
            ema.push(null);
        }
        ema.push(prevEma);

        for (var i = period; i < bars.length; i++) {
            prevEma = bars[i].close * k + prevEma * (1 - k);
            ema.push(prevEma);
        }

        return ema;
    }

    // ===== 核心：检测高窄旗形 =====
    function detectHighTightFlag(dailyBars, today, opts) {
        opts = opts || {};
        var minGain = opts.rallyMinGain || 30;
        var maxAmp = opts.flagMaxAmp || 20;
        var minDays = opts.flagMinDays || 10;
        var maxDays = opts.flagMaxDays || 40;
        var volCoef = opts.volShrink || 0.7;

        var result = {
            pass: false,
            rally: null,
            flag: null,
            breakout: null,
            details: []
        };

        if (!dailyBars || dailyBars.length < 60) {
            result.details.push('日K线不足60条，无法判断');
            return result;
        }

        // dailyBars 升序，最后一条是昨天（不含今天）
        // 在 bars[30 .. len-11] 范围找拉升高点（至少10天前，最多90天前）
        var totalBars = dailyBars.length;
        var searchStart = 30;
        var searchEnd = totalBars - 11; // 旗形至少需要10天

        if (searchEnd < searchStart) {
            result.details.push('数据不足：有效搜索区间为空');
            return result;
        }

        // === 阶段1：寻找拉升 ===
        // 找最近的满足条件的拉升（peakIdx最接近today）
        var bestRally = null;

        for (var peakIdx = searchEnd; peakIdx >= searchStart; peakIdx--) {
            var lookbackStart = Math.max(0, peakIdx - 60);
            var lookbackEnd = peakIdx - 20;
            if (lookbackEnd < 0) continue;

            // 找区间最低点
            var minLow = Infinity, minIdx = -1;
            for (var j = lookbackStart; j <= lookbackEnd; j++) {
                if (dailyBars[j].low < minLow) {
                    minLow = dailyBars[j].low;
                    minIdx = j;
                }
            }

            if (minIdx < 0) continue;

            var peakHigh = dailyBars[peakIdx].high;
            var gain = (peakHigh - minLow) / minLow * 100;

            if (gain >= minGain) {
                // 找到了！取最近的（peakIdx最大的）
                bestRally = {
                    startIdx: minIdx,
                    endIdx: peakIdx,
                    startLow: minLow,
                    endHigh: peakHigh,
                    startDate: dailyBars[minIdx].date,
                    endDate: dailyBars[peakIdx].date,
                    gain: gain,
                    duration: peakIdx - minIdx + 1
                };
                break; // 取最近的拉升
            }
        }

        if (!bestRally) {
            result.details.push('未找到' + minGain + '%+拉升（20-60天内）');
            return result;
        }
        result.rally = bestRally;
        result.details.push(
            '✓ 找到拉升: ' + bestRally.startDate + '~' + bestRally.endDate +
            ' +' + bestRally.gain.toFixed(1) + '% (' + bestRally.duration + '天)'
        );

        // === 阶段2：检查旗形整理 ===
        var flagStartIdx = bestRally.endIdx + 1;
        var flagEndIdx = totalBars - 1;
        var flagDuration = flagEndIdx - flagStartIdx + 1;

        if (flagDuration < minDays) {
            result.details.push('✗ 整理期太短: ' + flagDuration + '天 < ' + minDays + '天');
            return result;
        }
        if (flagDuration > maxDays) {
            result.details.push('✗ 整理期太长: ' + flagDuration + '天 > ' + maxDays + '天');
            return result;
        }

        // 振幅
        var flagHigh = -Infinity, flagLow = Infinity;
        var flagSumClose = 0, flagSumVol = 0;
        for (var k = flagStartIdx; k <= flagEndIdx; k++) {
            var bar = dailyBars[k];
            if (bar.high > flagHigh) flagHigh = bar.high;
            if (bar.low < flagLow) flagLow = bar.low;
            flagSumClose += bar.close;
            flagSumVol += bar.volume;
        }
        var flagAvgClose = flagSumClose / flagDuration;
        var flagAmplitude = (flagHigh - flagLow) / flagAvgClose * 100;

        if (flagAmplitude > maxAmp) {
            result.details.push('✗ 旗形振幅过大: ' + flagAmplitude.toFixed(1) + '% > ' + maxAmp + '%');
            return result;
        }

        // 始终在EMA20上方
        var ema20 = calcEMA(dailyBars, 20);
        var allAboveEMA = true;
        var belowDays = 0;
        for (var k = flagStartIdx; k <= flagEndIdx; k++) {
            if (ema20[k] !== null && dailyBars[k].close < ema20[k]) {
                belowDays++;
                if (belowDays > 2) { // 允许偶尔1-2天跌破
                    allAboveEMA = false;
                    break;
                }
            }
        }
        if (!allAboveEMA) {
            result.details.push('✗ 整理期跌破EMA20超过2天');
            return result;
        }

        // 缩量
        var rallySumVol = 0;
        for (var k = bestRally.startIdx; k <= bestRally.endIdx; k++) {
            rallySumVol += dailyBars[k].volume;
        }
        var rallyAvgVol = rallySumVol / bestRally.duration;
        var flagAvgVol = flagSumVol / flagDuration;

        if (flagAvgVol >= rallyAvgVol * volCoef) {
            result.details.push(
                '✗ 旗形未缩量: 日均' + (flagAvgVol/10000).toFixed(0) + '万 ≥ 拉升' + (rallyAvgVol/10000).toFixed(0) + '万×' + volCoef
            );
            return result;
        }

        result.flag = {
            startIdx: flagStartIdx,
            endIdx: flagEndIdx,
            startDate: dailyBars[flagStartIdx].date,
            endDate: dailyBars[flagEndIdx].date,
            duration: flagDuration,
            amplitude: flagAmplitude,
            flagHigh: flagHigh,
            flagLow: flagLow,
            avgVol: flagAvgVol,
            rallyAvgVol: rallyAvgVol,
            volRatio: flagAvgVol / rallyAvgVol,
            allAboveEMA: true
        };

        result.details.push(
            '✓ 旗形确认: ' + flagDuration + '天 振幅' + flagAmplitude.toFixed(1) +
            '% 量比' + result.flag.volRatio.toFixed(2) + ' EMA20上方'
        );

        // === 阶段3：今日突破 ===
        var todayHigh = today.high || today.price;
        var todayPrice = today.price || today.close;
        var todayVol = today.volume || 0;

        result.breakout = {
            breakFlagTop: false,
            volExpand: false,
            closeStrong: false,
            breakPct: 0,
            volExpandRatio: 0,
            closePctOfHigh: 0
        };

        // 突破旗顶
        if (todayHigh > flagHigh) {
            result.breakout.breakFlagTop = true;
            result.breakout.breakPct = (todayHigh - flagHigh) / flagHigh * 100;
            result.details.push('✓ 突破旗顶! 今高' + todayHigh.toFixed(2) + ' > 旗顶' + flagHigh.toFixed(2) + ' (+' + result.breakout.breakPct.toFixed(2) + '%)');
        } else {
            result.details.push('✗ 未突破 今高' + todayHigh.toFixed(2) + ' ≤ 旗顶' + flagHigh.toFixed(2));
            return result;
        }

        // 放量
        if (todayVol > 0 && flagAvgVol > 0) {
            result.breakout.volExpandRatio = todayVol / flagAvgVol;
            if (result.breakout.volExpandRatio >= 1.5) {
                result.breakout.volExpand = true;
                result.details.push('✓ 放量确认 今日量/旗形均量=' + result.breakout.volExpandRatio.toFixed(2));
            } else {
                result.details.push('✗ 未放量 今日量/旗形均量=' + result.breakout.volExpandRatio.toFixed(2) + ' < 1.5');
                // 不放量也先不淘汰，量比弱提示
            }
        }

        // 收盘强势
        result.breakout.closePctOfHigh = todayHigh > 0 ? todayPrice / todayHigh : 0;
        if (result.breakout.closePctOfHigh >= closeStrongPct) {
            result.breakout.closeStrong = true;
            result.details.push('✓ 收盘强势 ' + (result.breakout.closePctOfHigh*100).toFixed(0) + '%');
        } else {
            result.details.push('△ 收盘偏弱 ' + (result.breakout.closePctOfHigh*100).toFixed(0) + '%（仍可关注）');
        }

        // 综合判定：突破旗顶 + (放量 或 收盘强势)
        result.pass = result.breakout.breakFlagTop &&
                      (result.breakout.volExpand || result.breakout.closeStrong);

        if (result.pass) {
            result.details.push('★★★ 高窄旗形突破信号确认！');
        }

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
        debugLog('=== 高窄旗形突破 ===');
        debugLog('条件: 拉升≥' + rallyMinGain + '% + 旗形振幅≤' + flagMaxAmp + '% + 整理' + flagMinDays + '-' + flagMaxDays + '天 + 缩量');
        debugLog('选股: 今日涨幅≥' + changeMin + '%');
        debugLog('时间: ' + new Date().toLocaleTimeString());
        debugLog('');

        try {
            // ===== 阶段1：海选——扫描涨幅榜 =====
            showLoading('海选涨幅榜...', '涨幅≥' + changeMin + '%');
            var candidates = await getRisingStocks(debugLog, changeMin);
            debugLog('阶段1 候选: ' + candidates.length + '只 (涨幅≥' + changeMin + '%)');

            if (candidates.length === 0) {
                debugLog('无候选，停止');
                showResults([]);
                finishRefresh();
                return;
            }

            // ===== 阶段2：识旗 + 引爆 —— 拉120根K线验证 =====
            showLoading('验证高窄旗形...', '候选' + candidates.length + '只，拉取120日K线');
            var finalStocks = [];
            var batchSize = 3; // 120根K线较大，减小并发
            var processed = 0;
            var errors = 0;
            var rallyFound = 0;
            var flagFormed = 0;

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
                        turnover: r.stock.turnover,
                        close: r.stock.price
                    };

                    var flag = detectHighTightFlag(r.bars, today, {
                        rallyMinGain: rallyMinGain,
                        flagMaxAmp: flagMaxAmp,
                        flagMinDays: flagMinDays,
                        flagMaxDays: flagMaxDays,
                        volShrink: volShrink
                    });

                    if (flag.rally) rallyFound++;
                    if (flag.flag) flagFormed++;

                    if (flag.pass) {
                        finalStocks.push({
                            code: r.stock.code,
                            name: r.stock.name,
                            price: r.stock.price,
                            change: r.stock.change,
                            turnover: r.stock.turnover,
                            nmc: r.stock.nmc,
                            flagResult: flag
                        });
                    }
                    processed++;
                }

                var pct = Math.round(processed / candidates.length * 100);
                showLoading('验证高窄旗形...',
                    processed + '/' + candidates.length + ' (' + pct + '%) ' +
                    '拉升' + rallyFound + ' 旗形' + flagFormed + ' 信号' + finalStocks.length);

                if (bi + batchSize < candidates.length) await delay(300);
            }

            debugLog('');
            debugLog('=== 完成 ===');
            debugLog('候选: ' + candidates.length + ' | 拉升发现: ' + rallyFound + ' | 旗形成: ' + flagFormed + ' | 最终信号: ' + finalStocks.length + ' | 错误: ' + errors);

            if (finalStocks.length > 0) {
                debugLog('');
                finalStocks.forEach(function(s, idx) {
                    debugLog('【' + (idx+1) + '】' + s.code + ' ' + s.name + ' +' + s.change.toFixed(2) + '%');
                    s.flagResult.details.forEach(function(d) { debugLog('  ' + d); });
                });
            } else {
                debugLog('无高窄旗形突破信号。可能原因：');
                debugLog('  1. 当前市场环境不适合旗形交易');
                debugLog('  2. 可降低拉升阈值（30%→25%）或放宽振幅上限');
                debugLog('  3. 旗形突破是稀有信号，通常几天才出现一只');
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
        document.getElementById('resultBadge').textContent = '高窄旗形突破';
        renderFlagList('listResult', stocks);
    }

    function renderFlagList(containerId, stocks) {
        var container = document.getElementById(containerId);
        if (!stocks || stocks.length === 0) {
            container.innerHTML = '<div class="empty-state" style="padding:20px"><p class="empty-text">无高窄旗形突破信号</p><p class="empty-hint">这是稀有信号，通常几天甚至几周才出现一只</p></div>';
            return;
        }

        var html = '';
        stocks.forEach(function(s) {
            var f = s.flagResult;
            var rl = f.rally;
            var fl = f.flag;
            var br = f.breakout;
            var mktCapYi = s.nmc ? (s.nmc / 100000000).toFixed(0) : '--';

            html += '<div class="stock-card" style="border-left:3px solid #FF6B35;">' +
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
                    '<span class="flag-step">📈 拉升 +' + rl.gain.toFixed(0) + '%</span>' +
                    '<span class="flag-arrow">→</span>' +
                    '<span class="flag-step">🚩 旗形 ' + fl.duration + '天</span>' +
                    '<span class="flag-arrow">→</span>' +
                    '<span class="flag-step fire">🚀 突破 +' + br.breakPct.toFixed(2) + '%</span>' +
                '</div>' +
                '<div class="flag-detail-row">' +
                    '<span class="flag-label">拉升段</span>' +
                    '<span class="flag-val">' + rl.startDate + '~' + rl.endDate + ' (' + rl.duration + '天)</span>' +
                '</div>' +
                '<div class="flag-detail-row">' +
                    '<span class="flag-label">旗形</span>' +
                    '<span class="flag-val">振幅' + fl.amplitude.toFixed(1) + '% | 量缩至' + (fl.volRatio*100).toFixed(0) + '% | EMA20上方</span>' +
                '</div>' +
                '<div class="flag-detail-row">' +
                    '<span class="flag-label">突破</span>' +
                    '<span class="flag-val">' +
                        (br.breakFlagTop ? '✅突破旗顶' : '') +
                        (br.volExpand ? ' ✅放量×' + br.volExpandRatio.toFixed(1) : ' △量不足') +
                        ' | 强势' + (br.closePctOfHigh*100).toFixed(0) + '%' +
                    '</span>' +
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

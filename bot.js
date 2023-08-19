const express = require('express');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());

const config = require('./config.json');

const logsDir = path.join(__dirname, config.logsDir);

console.log('Loaded configuration:', config);

function calculateStats(lines) {
    const hitZoneCounts = lines.reduce((count, line) => {
        let hitZone = JSON.parse(line).zone;
        if (!["head", "brain", "torso"].includes(hitZone)) {
            hitZone = "others";
        }
        count[hitZone] = (count[hitZone] || 0) + 1;
        return count;
    }, {});

    const totalHits = Object.values(hitZoneCounts).reduce((a, b) => a + b, 0);
    const percentages = {};
    for (const [hitZone, count] of Object.entries(hitZoneCounts)) {
        percentages[hitZone] = (count / totalHits * 100).toFixed(2);
    }

    return percentages;
}

function calculateMedian(lines) {
    const distanceLists = lines.reduce((obj, line) => {
        const {zone, distance} = JSON.parse(line);
        let hitZone = zone;
        if (!["head", "brain", "torso"].includes(hitZone)) {
            hitZone = "others";
        }
        if (!obj[hitZone]) {
            obj[hitZone] = [];
        }
        obj[hitZone].push(distance);
        return obj;
    }, {});

    const medians = {};
    for (const [zone, distances] of Object.entries(distanceLists)) {
        const sorted = distances.sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        medians[zone] = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    return medians;
}


function thresholdCheck(stats, thresholds) {
    return thresholds.some(({zone, value}) => parseFloat(stats[zone]) >= value);
}


// check if the calculated value is on outlier
function isOutlier(value, lowerBound, upperBound) {
    return value < lowerBound || value > upperBound;
}

//QR is the range between the first quartile (25th percentile) and the third quartile (75th percentile) of the data. An outlier is then defined as observations that fall below Q1 - 1.5IQR or above Q3 + 1.5IQR.
function calculateIQR(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const q1 = sorted[Math.floor((sorted.length / 4))];
    const q3 = sorted[Math.ceil((sorted.length * 3) / 4)];
    const iqr = q3 - q1;
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;

    return {
        lowerBound,
        upperBound
    };
}

// formats the stats before sending them to discord
function formatStats(stats, medians, outliers, thresholdReached) {
    const hitZones = ["head", "brain", "torso", "others"];

    // Determine the maximum length for each field to align the columns
    const maxLength = {
        hitZone: Math.max(...hitZones.map(zone => zone.length)),
        hits: Math.max(...Object.values(stats).map(value => (`${parseFloat(value).toFixed(1)}%`).length), 6),
        median: Math.max(...Object.values(medians).map(median => median !== undefined ? `${parseFloat(median).toFixed(1)}m` : "N/A".length), 16)
    };

    let result = "|Hit Zone        |%Hits  |Median Distance|\n";

    hitZones.forEach(hitZone => {
        const value = (stats[hitZone] ? parseFloat(stats[hitZone]).toFixed(1) : "0.0");
        const formattedValue = `${value}%`.padEnd(maxLength.hits, ' ');
        const median = (medians[hitZone] !== undefined ? `${parseFloat(medians[hitZone]).toFixed(1)}m` : "N/A").padEnd(maxLength.median, ' ');
        const paddedHitZone = `\`${hitZone}\``.padEnd(maxLength.hitZone + 2, ' ');

        let statusMessage = `| ${paddedHitZone} | ${formattedValue} | ${median}|\n`;

        if (outliers.includes(hitZone) || thresholdReached.includes(hitZone)) {
            statusMessage = `>: ${statusMessage}`;
        }

        result += statusMessage;
    });

    return result;
}


// function to send message to Discord, can be triggered either by treshholds or calculateIQR
async function sendAlertToDiscord(murderer, murderer_id, shortTermStats, longTermStats, outliers, thresholdReached, title, shortTermLines, longTermLines, shortTermMedians, longTermMedians) {
    const url = `https://app.cftools.cloud/profile/${murderer_id}`;
	const shortTermStatsFormatted = formatStats(shortTermStats, shortTermMedians, outliers, thresholdReached);
	const longTermStatsFormatted = formatStats(longTermStats, longTermMedians, outliers, thresholdReached);
    const embed = {
        title: `Gaming Chair detected`,
        description: `Player: ${murderer}`,
        url: `${url}`,
        fields: [
            {
                name: 'Short-term statistics',
                value: shortTermStatsFormatted,
                inline: false,
            },
            {
                name: 'Number of short-term log entries',
                value: shortTermLines.length.toString(),
                inline: false,
            },
            {
                name: 'Long-term statistics',
                value: longTermStatsFormatted,
                inline: false,
            },
            {
                name: 'Number of long-term log entries',
                value: longTermLines.length.toString(),
                inline: false,
            },
        ],
    };

	const result = await fetch(config.webhookUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			content: `<@&${config.discord_role}>`, // This line pings the role
			embeds: [embed],
		}),
	});

    if (!result.ok) {
        console.error('Failed to send alert to Discord:', result.status, await result.text());
    }
}

// the actual listener for new data coming in via webhook
app.post('/', async function(req, res) {

    const {
        'x-hephaistos-signature': signature,
        'x-hephaistos-delivery': deliveryId,
        'x-hephaistos-event': eventType,
    } = req.headers;

    if (eventType === 'verification') {
        res.status(204).end();
        return;
    }

    const hash = crypto.createHash('sha256');
    hash.update(`${deliveryId}${config.webhookSecret}`, 'utf8');
    const localSignature = hash.digest('hex');

    if (localSignature !== signature) {
        console.log('Signature mismatch');
        res.status(401).end();
        return;
    }

    const murderer_id = req.body.murderer_id;
    const fileName = path.join(logsDir, `${murderer_id}.log`);
    const data = JSON.stringify(req.body) + '\n';

    try {
        await fs.appendFile(fileName, data);
    } catch (err) {
        console.error('Error writing to log file', err);
        res.status(500).end();
        return;
    }

    console.log('Saved log');
    
    const lines = (await fs.readFile(fileName, 'utf8')).split('\n').filter(Boolean);
    
    // We only want to proceed with analysis if the total number of log lines is a multiple of shortTermLogEntries
    if (lines.length % config.shortTermLogEntries !== 0) {
        console.log('Total log lines is not a multiple of shortTermLogEntries. Skipping alert.');
        res.status(204).end();
        return;
    }

    let shortTermLines = lines.slice(-config.shortTermLogEntries).filter(line => JSON.parse(line).distance >= config.min_distance);

    if (shortTermLines.length < config.minShortTermLogEntries) {
        console.log(`Not enough short-term logs remaining after filtering by min_distance. Required at least ${config.minShortTermLogEntries}. Skipping alert.`);
        res.status(204).end();
        return;
    } else {
        shortTermLines = shortTermLines.slice(-config.shortTermLogEntries);
    }
    
    const logEntry = JSON.parse(lines[lines.length - 1]);
    const murderer = logEntry.murderer;
    const longTermLines = lines;

    const shortTermStats = calculateStats(shortTermLines);
    const shortTermMedians = calculateMedian(shortTermLines);
    const longTermStats = calculateStats(lines);
    const longTermMedians = calculateMedian(longTermLines);

    const shortTermThresholdReached = config.shortTermThresholds
        .filter(({zone, value}) => parseFloat(shortTermStats[zone]) >= value)
        .map(({zone}) => zone);

    const longTermThresholdReached = config.longTermThresholds
        .filter(({zone, value}) => parseFloat(longTermStats[zone]) >= value)
        .map(({zone}) => zone);

    const thresholdReached = [...new Set([...shortTermThresholdReached, ...longTermThresholdReached])];

    let title = '';
	let outliers = [];
    
    if (thresholdReached.length > 0) {
		console.log('Threshold reached');
        title = 'Threshold in hit zone reached';
    }

	if (lines.length > 2 * config.shortTermLogEntries) {
		const longTermValues = Object.values(longTermStats).map(val => parseFloat(val));
		const { lowerBound, upperBound } = calculateIQR(longTermValues);

		outliers = Object.entries(shortTermStats)
			.filter(([hitZone, value]) => isOutlier(parseFloat(value), lowerBound, upperBound))
			.map(([hitZone]) => hitZone);

		if (outliers.length > 0) {
			console.log('Detected outliers');
			title = 'Outlier in hit zone detected';
		}
	}

    if (title) {
        await sendAlertToDiscord(murderer, murderer_id, shortTermStats, longTermStats, outliers, thresholdReached, title, shortTermLines, longTermLines, shortTermMedians, longTermMedians);
		console.log('Discord message sent');
    }

    res.status(204).end();
});

app.listen(config.port, function() {
    console.log(`Server started on port ${config.port}`);
});

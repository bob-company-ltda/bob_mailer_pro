import nodemailer from 'nodemailer';
import pLimit from 'p-limit';
import fs from 'fs';
import readline from 'readline';
import config from './config.json' with {type: "json"};
import * as EmailValidator from 'email-validator';
import chalk from 'chalk';

// Lista de remetentes com credenciais
const senders = config.senders;
const subject = config.subject;
const recipients_path = config.recipient_path;
const template_path = config.template_path;

const parallelEmails = config.parallel_emails; // Número de e-mails enviados em paralelo
const maxEmailsPerSender = 3000; // Número máximo de e-mails por remetente
const delayBetweenEmails = config.delay_between_emails;; // Atraso entre os disparos em milissegundos
const retryDelay = 30000; // Atraso entre tentativas de reenvio em milissegundos
const maxRetries = 3; // Número máximo de tentativas de reenvio

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createTransporter(sender) {
    return nodemailer.createTransport({
        host: sender.host,
        port: sender.port,
        secure: true,
        auth: {
            user: sender.email,
            pass: sender.password
        },
    });
}

async function replaceWithTemplate(recipient) {
    try {
        let data = fs.readFileSync(template_path, 'utf8');
        let name = recipient.name.trim();
        name = name.split(' ')[0];
        data = data.toString().replace(/{name}/g, name);
        return data;
    } catch (error) {
        throw new Error(`Erro ao criar o template de e-mail para ${recipient.email}: ${error}`);
    }
}

async function sendEmail(transporter, senderEmail, recipient, retryCount = 0) {
    try {
        if (!recipient.email) throw new Error('e-mail do destinatário não informado');
        const html = await replaceWithTemplate(recipient);
        let name = recipient.name.trim();
        name = name.split(' ')[0];
        const customSubject = subject.replace(/{name}/g, name);

        const mailOptions = {
            from: `Correios <${senderEmail}>`,
            to: recipient.email,
            date: new Date().toUTCString(),
            messageId: `${new Date().getMilliseconds()}@${config.domain}`,
            subject: customSubject,
            html
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`E-mail enviado por ${senderEmail} para ${recipient.email}: ${info.response}.`);
    } catch (error) {
        if (error.message.includes('too many AUTH commands') && retryCount < maxRetries) {
            console.log(chalk.red(`Erro ao enviar e-mail para ${recipient.email}: ${error.message}. Tentando novamente em ${retryDelay / 1000} segundos... (Tentativa ${retryCount + 1} de ${maxRetries})`));
            await sleep(retryDelay);
            await sendEmail(transporter, senderEmail, recipient, retryCount + 1);
        } else {
            throw new Error(`Erro ao enviar e-mail para ${recipient.email}: ${error.message}.`);
        }
    }
}

async function sendEmails(sender, recipientList) {
    const transporter = createTransporter(sender);
    const limit = pLimit(parallelEmails);
    let emailsSent = 0;

    const batchPromises = recipientList.slice(0, maxEmailsPerSender).map((recipient) =>
        limit(async () => {
            await sendEmail(transporter, sender.email, recipient);
            emailsSent++;
            console.log(chalk.blue(`Remetente ${sender.email} enviou ${emailsSent} e-mails.`));
            console.log(chalk.blue('Pausa de 5 segundos para o próximo envio...'));
            await sleep(delayBetweenEmails, sender.email);
        })
    );

    await Promise.all(batchPromises);
}

async function readRecipientsFromCSV(filePath) {
    const recipients = [];
    return new Promise((resolve, reject) => {
        const readInterface = readline.createInterface({
            input: fs.createReadStream(filePath),
            console: false
        });

        readInterface.on('line', (line) => {
            if (!line) reject(new Error('Arquivo de destinatários vazio'));
            const [email, name] = line.split(',');
            if (EmailValidator.validate(email)) {
                recipients.push({ email, name });
            } else {
                console.log(chalk.red(`E-mail inválido: ${email}`));
            }
        });

        readInterface.on('close', () => {
            console.log(chalk.blue('Leitura do arquivo concluída.'));
            resolve(recipients);
        });

        readInterface.on('error', (error) => {
            reject(new Error(`Erro ao ler o arquivo ${filePath}, verifique se o caminho está correto`, error.message));
        });
    });
}

async function distributeEmails(senders, recipients) {
    const senderPromises = senders.map((sender, index) => {
        const senderRecipients = recipients.filter((_, i) => i % senders.length === index);
        return sendEmails(sender, senderRecipients);
    });
    await Promise.all(senderPromises);
}

(async () => {
    try {
        const recipients = await readRecipientsFromCSV(recipients_path);
        console.log(chalk.green('Arquivo processado com sucesso'));
        console.log(chalk.blue('Iniciando disparo'));
        await distributeEmails(senders, recipients);
    } catch (error) {
        console.error(error.message);
    } finally {
        process.exit();
    }
})();